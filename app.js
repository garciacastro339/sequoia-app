// App Sequoia: lee la hoja "Sequoia datos" con la cuenta de Google de quien la usa.
(function () {
  const CFG = window.SEQUOIA_CONFIG;
  const TOKEN_KEY = "sequoia_token";
  const $ = (s) => document.querySelector(s);

  // ---------- Sesión de Google (flujo por redirección: funciona en la app del iPhone) ----------

  function redirectUri() {
    // Siempre la carpeta de la app, sin "index.html", para que coincida con lo registrado en Google.
    return location.origin + location.pathname.replace(/index\.html$/, "");
  }

  function saveTokenFromHash() {
    if (!location.hash.includes("access_token=")) return;
    const p = new URLSearchParams(location.hash.slice(1));
    const state = p.get("state");
    if (state && state === sessionStorage.getItem("sequoia_state")) {
      const exp = Date.now() + (Number(p.get("expires_in")) - 60) * 1000;
      store(TOKEN_KEY, JSON.stringify({ token: p.get("access_token"), exp }));
    }
    history.replaceState(null, "", redirectUri());
  }

  function getToken() {
    try {
      const t = JSON.parse(read(TOKEN_KEY));
      return t && t.exp > Date.now() ? t.token : null;
    } catch (e) {
      return null;
    }
  }

  function login() {
    const state = Math.random().toString(36).slice(2);
    sessionStorage.setItem("sequoia_state", state);
    const q = new URLSearchParams({
      client_id: CFG.clientId,
      redirect_uri: redirectUri(),
      response_type: "token",
      scope: CFG.scopes.join(" "),
      include_granted_scopes: "true",
      state,
    });
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + q;
  }

  function logout() {
    const t = getToken();
    remove(TOKEN_KEY);
    if (t) fetch("https://oauth2.googleapis.com/revoke?token=" + t, { method: "POST" }).catch(() => {});
    showLogin("");
  }

  // localStorage puede fallar en modo privado; la app sigue funcionando, solo pide entrar más seguido.
  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function remove(k) { try { localStorage.removeItem(k); } catch (e) {} }

  // ---------- Google Sheets ----------

  class AuthError extends Error {}

  async function api(url) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + getToken() } });
    if (r.status === 401) throw new AuthError("Sesión vencida");
    if (r.status === 403) throw new Error("Esta cuenta de Google no tiene permiso en la hoja o el calendario de Sequoia.");
    if (!r.ok) throw new Error("Google respondió con un error (" + r.status + ").");
    return r.json();
  }

  // Convierte cada pestaña en una lista de objetos usando los encabezados de la fila 1.
  async function loadSheet(tabs) {
    const q = tabs.map((t) => "ranges=" + encodeURIComponent("'" + t + "'")).join("&");
    const data = await api(`https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values:batchGet?${q}`);
    const out = {};
    data.valueRanges.forEach((vr, i) => {
      const [head = [], ...rows] = vr.values || [];
      out[tabs[i]] = rows
        .filter((r) => r.some((c) => c !== ""))
        .map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ""])));
    });
    return out;
  }

  // ---------- Fechas y dinero ----------

  // Fecha de hoy en Ezequiel Montes como "YYYY-MM-DD".
  function today() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CFG.timeZone }).format(new Date());
  }
  function addDays(iso, n) {
    const d = new Date(iso + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function longDate(iso) {
    const s = new Date(iso + "T12:00:00Z").toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
    return (s.charAt(0).toUpperCase() + s.slice(1)).replace(",", "");
  }
  function weekStart(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return addDays(iso, -((d.getUTCDay() + 6) % 7)); // semana de lunes a domingo
  }
  const num = (v) => Number(String(v).replace(/[$,\s]/g, "")) || 0;
  const money = (n) => "$" + Math.round(n).toLocaleString("es-MX");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- Pantallas ----------

  let DATA = null;
  let tab = "inicio";

  const SOON = {
    agenda: ["Agenda", "Calendario del mes, lista de pedidos y el botón + para agendar. Llega en la fase 3."],
    dinero: ["Dinero", "Ingresos, gastos y si el mes fue productivo. Llega en la fase 4."],
    inventario: ["Inventario", "Flores por lotes con su frescura, papel, listón y lista de compras. Llega en la fase 5."],
    precios: ["Precios", "Precio justo por ramo según lo que te costó y tus ventas. Llega en la fase 6."],
  };

  function setTop(title, sub) {
    $("#top-title").textContent = title;
    $("#top-sub").textContent = sub;
  }

  function render() {
    document.querySelectorAll(".nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    const v = $("#view");
    if (tab === "ajustes") return renderAjustes(v);
    if (tab !== "inicio") {
      const [t, p] = SOON[tab];
      setTop(t, "Próximamente");
      v.innerHTML = `<div class="soon"><b>${t}</b><p>${p}</p></div>`;
      return;
    }
    renderInicio(v);
  }

  function pagado(p) {
    return DATA.Pagos.filter((x) => x.pedido_id === p.id).reduce((a, x) => a + num(x.monto), 0);
  }

  function pedidoCard(p, extra) {
    const total = num(p.total) || num(p.precio_ramo) + num(p.costo_envio);
    const falta = total - pagado(p);
    const pill = total === 0 ? `<span class="pill pr">Sin precio</span>`
      : falta > 0 ? `<span class="pill pa">Falta ${money(falta)}</span>`
      : `<span class="pill pv">Pagado</span>`;
    const ramo = p.ramo_nombre || p.descripcion || "Ramo por definir";
    const quien = p.recibe_nombre || p.envia_nombre;
    const entrega = p.entrega === "Envío" ? "Envío a " + (p.pueblo === "Otro" ? p.pueblo_otro || "otro pueblo" : p.pueblo || "por definir")
      : p.entrega === "Tienda" ? "Recoge en tienda" : "Entrega por definir";
    const sub = extra || [entrega, p.canal].filter(Boolean).join(" · ");
    return `<div class="card"><span class="t">${esc([p.hora, ramo, quien].filter(Boolean).join(" · "))}</span>${pill}<span class="s">${esc(sub)}</span></div>`;
  }

  function renderInicio(v) {
    const hoy = today();
    const man = addDays(hoy, 1);
    setTop("Sequoia", longDate(hoy));
    if (!DATA) { v.innerHTML = `<div class="loading">Cargando…</div>`; return; }

    const aj = Object.fromEntries(DATA.Ajustes.map((r) => [r.clave, r.valor]));
    const activos = DATA.Pedidos.filter((p) => p.estado !== "Cancelado" && p.estado !== "Entregado");
    const delDia = (d) => activos.filter((p) => p.fecha_entrega === d).sort((a, b) => a.hora.localeCompare(b.hora));

    const mes = hoy.slice(0, 7);
    const semana = weekStart(hoy);
    const ingresos = (desde) => DATA.Pagos.filter((x) => x.fecha >= desde && x.fecha <= hoy).reduce((a, x) => a + num(x.monto), 0);
    const gastosMes = DATA.Gastos.filter((x) => x.fecha.startsWith(mes)).reduce((a, x) => a + num(x.monto), 0);
    const ingMes = ingresos(mes + "-01");
    const neto = ingMes - gastosMes;

    const hoyL = delDia(hoy), manL = delDia(man);
    const cap = num(aj.capacidad_sencillos_dia) || 6;
    const diasComplejo = num(aj.aviso_complejo_dias) || 3;
    const empezar = activos.filter((p) => p.tipo === "Complejo" && p.fecha_entrega > man && p.fecha_entrega <= addDays(hoy, diasComplejo));
    const diasVinil = num(aj.aviso_vinil_dias) || 2;
    const vinil = activos.filter((p) => p.liston === "Sí" && p.vinil_encargado !== "Sí" && p.fecha_entrega
      && addDays(p.fecha_entrega, -diasVinil) <= addDays(hoy, 2));

    let h = `<div class="kp">
      <div><span>Semana</span><b>${money(ingresos(semana))}</b></div>
      <div><span>Mes</span><b>${money(ingMes)}</b></div>
      <div><span>Neto mes</span><b style="color:${neto >= 0 ? "var(--verde)" : "var(--rojo)"}">${money(neto)}</b></div>
    </div>`;
    h += `<div class="h">Hoy <span>${hoyL.length} de ${cap} lugares</span></div>`;
    h += hoyL.length ? hoyL.map((p) => pedidoCard(p)).join("") : `<div class="empty">No hay pedidos para hoy.</div>`;
    h += `<div class="h">Mañana <span>${manL.length} ${manL.length === 1 ? "pedido" : "pedidos"}</span></div>`;
    h += manL.length ? manL.map((p) => pedidoCard(p)).join("") : `<div class="empty">No hay pedidos para mañana.</div>`;
    if (empezar.length) {
      h += `<div class="lbl" style="color:var(--rosa)">Hay que empezar</div>`;
      h += empezar.map((p) => pedidoCard(p, "Complejo · entrega " + longDate(p.fecha_entrega).toLowerCase())).join("");
    }
    vinil.forEach((p) => {
      const dia = addDays(p.fecha_entrega, -diasVinil);
      const cuando = dia <= hoy ? "Hoy" : longDate(dia);
      h += `<div class="alarm">${esc(cuando)}: mandar a hacer el vinil de ${esc(p.recibe_nombre || p.envia_nombre)}</div>`;
    });
    v.innerHTML = h;
  }

  function renderAjustes(v) {
    setTop("Ajustes", "Datos del negocio y conexión");
    const aj = DATA ? Object.fromEntries(DATA.Ajustes.map((r) => [r.clave, r.valor])) : {};
    const fijos = num(aj.renta) + num(aj.luz_agua);
    v.innerHTML = `
      <div class="lbl">Negocio</div>
      <div class="card"><span class="t">Gastos fijos al mes</span><span class="t">${money(fijos)}</span><span class="s">Renta ${money(num(aj.renta))} · luz y agua ${money(num(aj.luz_agua))}</span></div>
      <div class="card"><span class="t">Anticipo</span><span class="t">${esc(aj.anticipo_pct || 50)}%</span><span class="s">No se devuelve si cancelan</span></div>
      <div class="card"><span class="t">Subir precio</span><span></span><span class="s">Fecha fuerte +${esc(aj.recargo_fecha_fuerte_pct || 10)}% · urgente +${esc(aj.recargo_urgente_pct || 10)}% · tope ${esc(aj.tope_recargo_pct || 25)}%</span></div>
      <div class="card"><span class="t">Lugar de compra</span><span></span><span class="s">${esc(aj.lugar_compra || "Bodega MCP")}</span></div>
      <div class="lbl">Cuenta</div>
      <div class="card"><span class="t">Hoja "Sequoia datos"</span><span id="st-sheet" class="pill ${DATA ? "pv" : "pa"}">${DATA ? "Conectada" : "Revisando"}</span></div>
      <div class="card"><span class="t">Calendario "Pedidos Sequoia"</span><span id="st-cal" class="pill pa">Revisando</span></div>
      <p class="empty">Estos datos se cambian en la pestaña "Ajustes" de la hoja de Google.</p>
      <button id="btn-out" class="btn2">Cerrar sesión</button>`;
    $("#btn-out").onclick = logout;
    api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CFG.calendarId)}/events?maxResults=1`)
      .then(() => setPill("#st-cal", "pv", "Conectado"))
      .catch(() => setPill("#st-cal", "pj", "Sin acceso"));
  }

  function setPill(sel, cls, text) {
    const el = $(sel);
    if (el) { el.className = "pill " + cls; el.textContent = text; }
  }

  // ---------- Arranque ----------

  function showLogin(msg) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#login-msg").textContent = msg || "";
  }

  async function start() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    render();
    try {
      DATA = await loadSheet(["Pedidos", "Pagos", "Gastos", "Ajustes"]);
      render();
    } catch (e) {
      if (e instanceof AuthError) { remove(TOKEN_KEY); return showLogin("Tu sesión terminó. Vuelve a entrar."); }
      $("#view").innerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  }

  $("#btn-login").onclick = login;
  $("#btn-ajustes").onclick = () => { tab = "ajustes"; render(); };
  document.querySelectorAll(".nav button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));

  // Al volver a abrir la app después de un rato, recarga los datos.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && DATA) {
      if (!getToken()) return showLogin("Tu sesión terminó. Vuelve a entrar.");
      loadSheet(["Pedidos", "Pagos", "Gastos", "Ajustes"]).then((d) => { DATA = d; render(); }).catch(() => {});
    }
  });

  if (location.hash.includes("error=")) {
    history.replaceState(null, "", redirectUri());
    showLogin("No se pudo entrar con Google. Intenta de nuevo.");
  } else {
    saveTokenFromHash();
    getToken() ? start() : showLogin("");
  }
})();
