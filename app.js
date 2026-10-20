// App Sequoia: lee y escribe la hoja "Sequoia datos" y el calendario con la cuenta de Google de quien la usa.
(function () {
  const CFG = window.SEQUOIA_CONFIG;
  const TOKEN_KEY = "sequoia_token";
  const TABS = ["Pedidos", "Pagos", "Gastos", "Ajustes", "Ramos", "Fechas fuertes"];
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

  // ---------- Google Sheets y Calendar ----------

  class AuthError extends Error {}

  async function api(url, method = "GET", body) {
    const opts = { method, headers: { Authorization: "Bearer " + getToken() } };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    if (r.status === 401) throw new AuthError("Sesión vencida");
    if (!r.ok) {
      const e = new Error(r.status === 403
        ? "Esta cuenta de Google no tiene permiso en la hoja o el calendario de Sequoia."
        : "Google respondió con un error (" + r.status + ").");
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? null : r.json();
  }

  const SHEETS = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}`;
  const range = (tab, a1) => encodeURIComponent("'" + tab + "'" + (a1 ? "!" + a1 : ""));
  const HEAD = {}; // encabezados de cada pestaña, en orden

  // Convierte cada pestaña en una lista de objetos usando los encabezados de la fila 1.
  async function loadSheet() {
    const q = TABS.map((t) => "ranges=" + range(t)).join("&");
    const data = await api(`${SHEETS}/values:batchGet?${q}`);
    const out = {};
    data.valueRanges.forEach((vr, i) => {
      const [head = [], ...rows] = vr.values || [];
      HEAD[TABS[i]] = head;
      out[TABS[i]] = rows
        .filter((r) => r.some((c) => c !== ""))
        .map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] ?? ""])));
    });
    return out;
  }

  const rowValues = (tab, obj) => HEAD[tab].map((h) => obj[h] ?? "");

  async function appendRow(tab, obj) {
    await api(`${SHEETS}/values/${range(tab, "A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, "POST",
      { values: [rowValues(tab, obj)] });
  }

  function colLetter(n) {
    let s = "";
    for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // Busca la fila por su id justo antes de escribir, por si alguien más agregó filas mientras tanto.
  async function updateRow(tab, obj) {
    const col = await api(`${SHEETS}/values/${range(tab, "A:A")}`);
    const i = (col.values || []).findIndex((r) => r[0] === obj.id);
    if (i < 1) throw new Error("No encontré ese pedido en la hoja. Recarga e intenta de nuevo.");
    const a1 = `A${i + 1}:${colLetter(HEAD[tab].length - 1)}${i + 1}`;
    await api(`${SHEETS}/values/${range(tab, a1)}?valueInputOption=RAW`, "PUT", { values: [rowValues(tab, obj)] });
  }

  const EVENTS = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(CFG.calendarId)}/events`;

  // ---------- Fechas y dinero ----------

  // Fecha de hoy en Ezequiel Montes como "YYYY-MM-DD".
  function today() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: CFG.timeZone }).format(new Date());
  }
  function nowStamp() {
    const t = new Intl.DateTimeFormat("en-GB", { timeZone: CFG.timeZone, hour: "2-digit", minute: "2-digit" }).format(new Date());
    return today() + " " + t;
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
  function monthName(ym) {
    const s = new Date(ym + "-15T12:00:00Z").toLocaleDateString("es-MX", { month: "long", year: "numeric", timeZone: "UTC" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function weekStart(iso) {
    const d = new Date(iso + "T12:00:00Z");
    return addDays(iso, -((d.getUTCDay() + 6) % 7)); // semana de lunes a domingo
  }
  const num = (v) => Number(String(v).replace(/[$,\s]/g, "")) || 0;
  const money = (n) => "$" + Math.round(n).toLocaleString("es-MX");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- Reglas del negocio ----------

  let DATA = null;
  let tab = "inicio";
  let agendaView = "mes";
  let agendaMonth = today().slice(0, 7);
  let agendaDay = today();

  const ajustes = () => Object.fromEntries(DATA.Ajustes.map((r) => [r.clave, r.valor]));
  const activo = (p) => p.estado !== "Cancelado" && p.estado !== "Entregado";
  const totalDe = (p) => num(p.total) || num(p.precio_ramo) + num(p.costo_envio);
  const pagado = (p) => DATA.Pagos.filter((x) => x.pedido_id === p.id).reduce((a, x) => a + num(x.monto), 0);
  const quienRecibe = (p) => p.recibe_nombre || p.envia_nombre || "Sin nombre";
  const ramoDe = (p) => p.ramo_nombre || p.descripcion || "Ramo por definir";

  // Un ramo complejo ocupa varios lugares del día (Ajustes: lugares_complejo).
  function lugares(lista) {
    const porComplejo = num(ajustes().lugares_complejo) || 3;
    return lista.reduce((a, p) => a + (p.tipo === "Complejo" ? porComplejo : 1), 0);
  }
  const capacidad = () => num(ajustes().capacidad_sencillos_dia) || 6;
  const delDia = (d) => DATA.Pedidos.filter((p) => activo(p) && p.fecha_entrega === d).sort((a, b) => a.hora.localeCompare(b.hora));

  function fechaFuerte(iso) {
    const r = iso && DATA["Fechas fuertes"].find((f) => f.fecha === iso.slice(5));
    return r ? r.nombre : "";
  }

  function entregaTexto(p) {
    if (p.entrega === "Envío") return "Envío a " + (p.pueblo === "Otro" ? p.pueblo_otro || "otro pueblo" : p.pueblo || "pueblo por definir");
    return p.entrega === "Tienda" ? "Recoge en tienda" : "Entrega por definir";
  }

  // Último precio y promedio del mismo ramo en pedidos entregados.
  function historialPrecio(ramoId) {
    const ventas = DATA.Pedidos.filter((p) => p.ramo_id === ramoId && p.estado === "Entregado" && num(p.precio_ramo) > 0)
      .sort((a, b) => a.fecha_entrega.localeCompare(b.fecha_entrega));
    if (!ventas.length) return null;
    const precios = ventas.map((p) => num(p.precio_ramo));
    return { ultimo: precios[precios.length - 1], promedio: precios.reduce((a, b) => a + b, 0) / precios.length, veces: ventas.length };
  }

  // ---------- Avisos en Google Calendar ----------

  function eventoBase(p, fecha, hora, minutos, titulo, avisos) {
    const fin = new Date(`${fecha}T${hora}:00Z`);
    fin.setUTCMinutes(fin.getUTCMinutes() + minutos);
    const lines = [
      `Ramo: ${ramoDe(p)}${p.tipo ? " (" + p.tipo + ")" : ""}`,
      p.descripcion && p.descripcion !== p.ramo_nombre ? `Idea: ${p.descripcion}` : "",
      `Entrega: ${p.fecha_entrega} ${p.hora || ""} · ${entregaTexto(p)}`,
      `Para: ${quienRecibe(p)}`,
      `De: ${p.envia_nombre} · ${p.envia_tel}${p.anonimo === "Sí" ? " (NO decir quién lo envía)" : ""}`,
      p.tarjeta === "Sí" ? `Tarjeta: ${p.tarjeta_mensaje}` : "",
      p.liston === "Sí" ? `Listón en vinil: ${p.liston_texto}` : "",
      `Total ${money(totalDe(p))} · pagado ${money(pagado(p))}`,
      p.notas ? `Notas: ${p.notas}` : "",
      `Pedido ${p.id} · ${redirectUri()}`,
    ];
    return {
      summary: titulo,
      description: lines.filter(Boolean).join("\n"),
      start: { dateTime: `${fecha}T${hora}:00`, timeZone: CFG.timeZone },
      end: { dateTime: fin.toISOString().slice(0, 16) + ":00", timeZone: CFG.timeZone },
      reminders: { useDefault: false, overrides: avisos.map((m) => ({ method: "popup", minutes: m })) },
    };
  }

  // Qué eventos debe tener el pedido según su estado; null = ninguno.
  function eventosDeseados(p) {
    const aj = ajustes();
    if (!p.fecha_entrega || p.estado === "Cancelado") return { evento_entrega_id: null, evento_empezar_id: null, evento_vinil_id: null };
    const hoy = today();
    const hora = p.hora || "10:00";
    const horasAntes = (num(aj.aviso_horas_antes) || 2) * 60;
    const diasAntes = p.tipo === "Complejo" ? num(aj.aviso_complejo_dias) || 3 : num(aj.aviso_sencillo_dias) || 1;
    const sigue = activo(p);
    const nunca_antes_de_hoy = (d) => (d < hoy ? hoy : d);
    const titulo = `${p.estado === "Entregado" ? "✓ " : ""}${hora} · ${ramoDe(p)} · ${quienRecibe(p)}`;
    return {
      evento_entrega_id: eventoBase(p, p.fecha_entrega, hora, 30, titulo, [horasAntes, diasAntes * 1440]),
      evento_empezar_id: sigue && p.tipo === "Complejo"
        ? eventoBase(p, nunca_antes_de_hoy(addDays(p.fecha_entrega, -diasAntes)), "09:00", 30, `Empezar: ${ramoDe(p)} · ${quienRecibe(p)}`, [0])
        : null,
      evento_vinil_id: sigue && p.liston === "Sí" && p.vinil_encargado !== "Sí"
        ? eventoBase(p, nunca_antes_de_hoy(addDays(p.fecha_entrega, -(num(aj.aviso_vinil_dias) || 2))), "09:00", 15,
          `Mandar a hacer vinil: ${p.liston_texto || quienRecibe(p)}`, [0])
        : null,
    };
  }

  // Crea, cambia o borra los eventos del pedido. Si algo falla, el pedido se guarda igual.
  async function sincronizarEventos(p) {
    let fallo = false;
    for (const [campo, ev] of Object.entries(eventosDeseados(p))) {
      const id = p[campo];
      try {
        if (ev && id) {
          try {
            await api(`${EVENTS}/${encodeURIComponent(id)}`, "PUT", ev);
          } catch (e) {
            if (e.status !== 404 && e.status !== 410) throw e;
            p[campo] = (await api(EVENTS, "POST", ev)).id;
          }
        } else if (ev) {
          p[campo] = (await api(EVENTS, "POST", ev)).id;
        } else if (id) {
          await api(`${EVENTS}/${encodeURIComponent(id)}`, "DELETE").catch((e) => {
            if (e.status !== 404 && e.status !== 410) throw e;
          });
          p[campo] = "";
        }
      } catch (e) {
        if (e instanceof AuthError) throw e;
        fallo = true;
      }
    }
    return !fallo;
  }

  // Guarda el pedido en la hoja con sus eventos al día.
  async function guardarPedido(p, nuevo) {
    p.actualizado = nowStamp();
    const total = num(p.precio_ramo) + num(p.costo_envio);
    p.total = total || "";
    p.urgente = p.fecha_entrega && p.fecha_entrega <= addDays(today(), 1) ? "Sí" : "No";
    p.fecha_fuerte = fechaFuerte(p.fecha_entrega);
    const calOk = await sincronizarEventos(p);
    if (nuevo) await appendRow("Pedidos", p);
    else await updateRow("Pedidos", p);
    return calOk;
  }

  async function registrarPago(p, tipo, monto, forma) {
    await appendRow("Pagos", {
      id: "PG-" + today().replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6),
      fecha: today(), pedido_id: p.id, tipo, monto, forma, notas: "",
    });
  }

  // ---------- Pantallas ----------

  const SOON = {
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
    if (SOON[tab]) {
      const [t, p] = SOON[tab];
      setTop(t, "Próximamente");
      v.innerHTML = `<div class="soon"><b>${t}</b><p>${p}</p></div>`;
      return;
    }
    if (!DATA) {
      setTop(tab === "agenda" ? "Agenda" : "Sequoia", longDate(today()));
      v.innerHTML = `<div class="loading">Cargando…</div>`;
      return;
    }
    if (tab === "agenda") renderAgenda(v);
    else renderInicio(v);
    if (tab === "agenda" || tab === "inicio") v.insertAdjacentHTML("beforeend", `<button class="fab" data-act="nuevo" aria-label="Nuevo pedido">+</button>`);
  }

  function pedidoCard(p, extra) {
    const total = totalDe(p);
    const falta = total - pagado(p);
    const pill = p.estado === "Listo" ? `<span class="pill pv">Listo</span>`
      : total === 0 ? `<span class="pill pr">Sin precio</span>`
      : falta > 0 ? `<span class="pill pa">Falta ${money(falta)}</span>`
      : `<span class="pill pv">Pagado</span>`;
    const sub = extra || [entregaTexto(p), p.canal].filter(Boolean).join(" · ");
    return `<div class="card" data-id="${esc(p.id)}"><span class="t">${esc([p.hora, ramoDe(p), quienRecibe(p)].filter(Boolean).join(" · "))}</span>${pill}<span class="s">${esc(sub)}</span></div>`;
  }

  function renderInicio(v) {
    const hoy = today();
    const man = addDays(hoy, 1);
    setTop("Sequoia", longDate(hoy));
    const aj = ajustes();
    const activos = DATA.Pedidos.filter(activo);

    const mes = hoy.slice(0, 7);
    const ingresos = (desde) => DATA.Pagos.filter((x) => x.fecha >= desde && x.fecha <= hoy).reduce((a, x) => a + num(x.monto), 0);
    const gastosMes = DATA.Gastos.filter((x) => x.fecha.startsWith(mes)).reduce((a, x) => a + num(x.monto), 0);
    const ingMes = ingresos(mes + "-01");
    const neto = ingMes - gastosMes;

    const hoyL = delDia(hoy), manL = delDia(man);
    const diasComplejo = num(aj.aviso_complejo_dias) || 3;
    const empezar = activos.filter((p) => p.tipo === "Complejo" && p.fecha_entrega > man && p.fecha_entrega <= addDays(hoy, diasComplejo));
    const diasVinil = num(aj.aviso_vinil_dias) || 2;
    const vinil = activos.filter((p) => p.liston === "Sí" && p.vinil_encargado !== "Sí" && p.fecha_entrega
      && addDays(p.fecha_entrega, -diasVinil) <= addDays(hoy, 2));

    let h = `<div class="kp">
      <div><span>Semana</span><b>${money(ingresos(weekStart(hoy)))}</b></div>
      <div><span>Mes</span><b>${money(ingMes)}</b></div>
      <div><span>Neto mes</span><b style="color:${neto >= 0 ? "var(--verde)" : "var(--rojo)"}">${money(neto)}</b></div>
    </div>`;
    h += `<div class="h">Hoy <span>${lugares(hoyL)} de ${capacidad()} lugares</span></div>`;
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
      h += `<div class="alarm" data-id="${esc(p.id)}">${esc(cuando)}: mandar a hacer el vinil de ${esc(quienRecibe(p))}</div>`;
    });
    v.innerHTML = h;
  }

  function renderAgenda(v) {
    const hoy = today();
    let h = `<div class="seg"><button data-act="vista" data-v="mes" class="${agendaView === "mes" ? "on" : ""}">Mes</button><button data-act="vista" data-v="lista" class="${agendaView === "lista" ? "on" : ""}">Lista</button></div>`;

    if (agendaView === "lista") {
      setTop("Agenda", "Próximos pedidos");
      const prox = DATA.Pedidos.filter((p) => activo(p) && (!p.fecha_entrega || p.fecha_entrega >= hoy))
        .sort((a, b) => (a.fecha_entrega || "0").localeCompare(b.fecha_entrega || "0") || a.hora.localeCompare(b.hora));
      if (!prox.length) h += `<div class="empty">No hay pedidos próximos. Toca + para agendar uno.</div>`;
      let dia = null;
      prox.forEach((p) => {
        const d = p.fecha_entrega || "sin";
        if (d !== dia) {
          dia = d;
          const lleno = d !== "sin" && lugares(delDia(d)) >= capacidad();
          const nombre = d === "sin" ? "Sin fecha todavía" : d === hoy ? "Hoy · " + longDate(d).toLowerCase() : d === addDays(hoy, 1) ? "Mañana · " + longDate(d).toLowerCase() : longDate(d);
          h += `<div class="lbl">${esc(nombre)}${lleno ? " · día lleno" : ""}</div>`;
        }
        h += pedidoCard(p);
      });
      v.innerHTML = h;
      return;
    }

    setTop("Agenda", monthName(agendaMonth));
    const first = agendaMonth + "-01";
    const offset = (new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7;
    const dias = new Date(Date.UTC(+agendaMonth.slice(0, 4), +agendaMonth.slice(5, 7), 0)).getUTCDate();
    h += `<div class="monthbar"><button data-act="mes" data-v="-1" aria-label="Mes anterior">‹</button>${esc(monthName(agendaMonth))}<button data-act="mes" data-v="1" aria-label="Mes siguiente">›</button></div>`;
    h += `<div class="cal">` + ["L", "M", "M", "J", "V", "S", "D"].map((d) => `<span class="w">${d}</span>`).join("");
    h += "<span></span>".repeat(offset);
    for (let i = 1; i <= dias; i++) {
      const d = `${agendaMonth}-${String(i).padStart(2, "0")}`;
      const lista = delDia(d);
      const lleno = lugares(lista) >= capacidad();
      const cls = ["d", d === hoy ? "today" : "", d === agendaDay ? "sel" : ""].join(" ");
      h += `<button class="${cls}" data-act="dia" data-v="${d}">${i}${lista.length ? `<em class="n${lleno ? " full" : ""}">${lista.length}</em>` : ""}</button>`;
    }
    h += `</div>`;
    const sel = delDia(agendaDay);
    const lleno = sel.length && lugares(sel) >= capacidad();
    h += `<div class="h">${esc(longDate(agendaDay))} ${lleno ? `<span class="pill pj">Día lleno</span>` : `<span>${lugares(sel)} de ${capacidad()} lugares</span>`}</div>`;
    h += sel.length ? sel.map((p) => pedidoCard(p)).join("") : `<div class="empty">Sin pedidos este día.</div>`;
    v.innerHTML = h;
  }

  function renderAjustes(v) {
    setTop("Ajustes", "Datos del negocio y conexión");
    const aj = DATA ? ajustes() : {};
    const fijos = num(aj.renta) + num(aj.luz_agua);
    v.innerHTML = `
      <div class="lbl">Negocio</div>
      <div class="card"><span class="t">Gastos fijos al mes</span><span class="t">${money(fijos)}</span><span class="s">Renta ${money(num(aj.renta))} · luz y agua ${money(num(aj.luz_agua))}</span></div>
      <div class="card"><span class="t">Anticipo</span><span class="t">${esc(aj.anticipo_pct || 50)}%</span><span class="s">No se devuelve si cancelan</span></div>
      <div class="card"><span class="t">Lugares por día</span><span class="t">${esc(aj.capacidad_sencillos_dia || 6)}</span><span class="s">Un ramo complejo ocupa ${esc(aj.lugares_complejo || 3)} lugares</span></div>
      <div class="card"><span class="t">Avisos en el calendario</span><span></span><span class="s">Sencillo ${esc(aj.aviso_sencillo_dias || 1)} día antes · complejo ${esc(aj.aviso_complejo_dias || 3)} días antes · vinil ${esc(aj.aviso_vinil_dias || 2)} días antes · y ${esc(aj.aviso_horas_antes || 2)} h antes de entregar</span></div>
      <div class="card"><span class="t">Subir precio</span><span></span><span class="s">Fecha fuerte +${esc(aj.recargo_fecha_fuerte_pct || 10)}% · urgente +${esc(aj.recargo_urgente_pct || 10)}% · tope ${esc(aj.tope_recargo_pct || 25)}%</span></div>
      <div class="card"><span class="t">Lugar de compra</span><span></span><span class="s">${esc(aj.lugar_compra || "Bodega MCP")}</span></div>
      <div class="lbl">Cuenta</div>
      <div class="card"><span class="t">Hoja "Sequoia datos"</span><span id="st-sheet" class="pill ${DATA ? "pv" : "pa"}">${DATA ? "Conectada" : "Revisando"}</span></div>
      <div class="card"><span class="t">Calendario "Pedidos Sequoia"</span><span id="st-cal" class="pill pa">Revisando</span></div>
      <p class="empty">Estos datos se cambian en la pestaña "Ajustes" de la hoja de Google.</p>
      <button id="btn-out" class="btn2">Cerrar sesión</button>`;
    $("#btn-out").onclick = logout;
    api(`${EVENTS}?maxResults=1`)
      .then(() => setPill("#st-cal", "pv", "Conectado"))
      .catch(() => setPill("#st-cal", "pj", "Sin acceso"));
  }

  function setPill(sel, cls, text) {
    const el = $(sel);
    if (el) { el.className = "pill " + cls; el.textContent = text; }
  }

  // ---------- Ficha del pedido ----------

  function openFull(html) {
    const f = $("#full");
    f.innerHTML = html;
    f.hidden = false;
    f.scrollTop = 0;
  }
  function closeFull() {
    fichaId = null;
    $("#full").hidden = true;
    $("#full").innerHTML = "";
  }

  function toast(msg, bad) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast" + (bad ? " bad" : "");
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500);
  }

  function abrirFicha(id) {
    const p = DATA.Pedidos.find((x) => x.id === id);
    if (!p) return;
    fichaId = id;
    const total = totalDe(p);
    const pag = pagado(p);
    const falta = total - pag;
    const estadoCls = { Agendado: "pa", "En preparación": "pa", Listo: "pv", Entregado: "pv", Cancelado: "pj" }[p.estado] || "pa";
    const pagos = DATA.Pagos.filter((x) => x.pedido_id === p.id);
    let h = `<div class="sheethead"><button data-act="cerrar">‹ Volver</button><b>Para ${esc(quienRecibe(p).split(" ")[0])}</b><button data-act="editar" data-id="${esc(p.id)}">Editar</button></div><div class="sheetbody">`;
    h += `<div class="pills">${p.tipo ? `<span class="pill pr">${esc(p.tipo)}</span>` : ""}<span class="pill ${estadoCls}">${esc(p.estado || "Agendado")}</span>${p.canal ? `<span class="pill" style="background:var(--line);color:var(--muted)">${esc(p.canal)}</span>` : ""}${p.fecha_fuerte ? `<span class="pill pr">${esc(p.fecha_fuerte)}</span>` : ""}</div>`;
    h += `<div class="h" style="margin:0">${esc(ramoDe(p))}</div>`;
    if (p.descripcion && p.descripcion !== p.ramo_nombre) h += `<div class="info">${esc(p.descripcion)}</div>`;
    if (activo(p) && p.liston === "Sí" && p.vinil_encargado !== "Sí" && p.fecha_entrega) {
      h += `<div class="alarm">Mandar a hacer el vinil: ${esc(longDate(addDays(p.fecha_entrega, -(num(ajustes().aviso_vinil_dias) || 2))).toLowerCase())}</div>`;
    }
    h += `<div class="info">
      ${p.fecha_entrega ? `<b>${esc(longDate(p.fecha_entrega))}${p.hora ? " · " + esc(p.hora) : ""}</b>` : "<b>Sin fecha todavía</b>"}<br>
      Para: ${esc(p.recibe_nombre || "por definir")}<br>
      De: ${esc(p.envia_nombre)} · <a href="tel:${esc(p.envia_tel.replace(/[^\d+]/g, ""))}">${esc(p.envia_tel)}</a> ${p.anonimo === "Sí" ? `<span class="pill pj">No decir su nombre</span>` : ""}<br>
      ${esc(entregaTexto(p))}</div>`;
    const extras = [];
    if (p.tarjeta && p.tarjeta !== "No") extras.push(`<span class="s" style="grid-column:auto">Tarjeta</span><span class="t" style="font-weight:500">${p.tarjeta === "Sí" ? "“" + esc(p.tarjeta_mensaje || "sin mensaje aún") + "”" : "Por preguntar"}</span>`);
    if (p.liston && p.liston !== "No") extras.push(`<span class="s" style="grid-column:auto">Listón en vinil${p.vinil_encargado === "Sí" ? " · ya encargado" : ""}</span><span class="t" style="font-weight:500">${p.liston === "Sí" ? "“" + esc(p.liston_texto || "sin texto aún") + "”" : "Por preguntar"}</span>`);
    if (extras.length) h += `<div class="card" style="grid-template-columns:1fr">${extras.join("")}</div>`;
    if (p.notas) h += `<div class="info">Notas: ${esc(p.notas)}</div>`;
    h += `<div>
      <div class="row"><span>Ramo${num(p.costo_envio) ? " + envío" : ""}</span><span>${money(num(p.precio_ramo))}${num(p.costo_envio) ? " + " + money(num(p.costo_envio)) : ""}</span></div>
      ${pagos.map((x) => `<div class="row"><span>${esc(x.tipo)} (${esc(x.forma.toLowerCase())}) · ${esc(x.fecha.slice(8))}/${esc(x.fecha.slice(5, 7))}</span><span>${money(num(x.monto))}</span></div>`).join("")}
      <div class="row tot"><span>${falta > 0 ? "Falta cobrar" : "Pagado"}</span><span style="color:${falta > 0 ? "var(--ambar)" : "var(--verde)"}">${money(falta > 0 ? falta : pag)}</span></div>
    </div>`;
    if (activo(p)) {
      if (falta > 0) {
        h += `<div class="lbl">Entregar y cobrar ${money(falta)}</div><div class="two"><button class="btn" data-act="entregar" data-v="Efectivo" data-id="${esc(p.id)}">Efectivo</button><button class="btn" data-act="entregar" data-v="Transferencia" data-id="${esc(p.id)}">Transferencia</button></div>`;
      } else {
        h += `<button class="btn" data-act="entregar" data-id="${esc(p.id)}">Entregado</button>`;
      }
      h += `<div class="two">${p.estado === "Listo" ? `<button class="btn2" data-act="estado" data-v="Agendado" data-id="${esc(p.id)}">Aún no está listo</button>` : `<button class="btn2" data-act="estado" data-v="Listo" data-id="${esc(p.id)}">Ya está listo</button>`}<button class="btn2" style="color:var(--rojo)" data-act="cancelar" data-id="${esc(p.id)}">Cancelar pedido</button></div>`;
      if (p.liston === "Sí" && p.vinil_encargado !== "Sí") h += `<button class="btn2" data-act="vinil" data-id="${esc(p.id)}">Ya mandé a hacer el vinil</button>`;
    } else if (p.estado === "Cancelado") {
      h += `<div class="info">Pedido cancelado. El anticipo no se devuelve y se queda como ingreso.</div>`;
    }
    h += `</div>`;
    openFull(h);
  }

  // ---------- Nuevo pedido / editar ----------

  let editando = null; // copia del pedido que se está llenando
  let fichaId = null; // pedido cuya ficha está abierta

  const chip = (campo, opciones, valor) =>
    `<div class="chips" data-chip="${campo}">${opciones.map((o) => `<button type="button" data-v="${esc(o)}" class="${o === valor ? "on" : ""}">${esc(o)}</button>`).join("")}</div>`;

  function abrirFormulario(id) {
    const base = id ? DATA.Pedidos.find((x) => x.id === id) : null;
    editando = base ? { ...base } : {
      id: "P-" + today().replace(/-/g, "") + "-" + Math.random().toString(36).slice(2, 6).toUpperCase(),
      creado: nowStamp(), estado: "Agendado", anonimo: "No", tarjeta: "Por preguntar", liston: "No", vinil_encargado: "No",
      fecha_entrega: tab === "agenda" && agendaView === "mes" && agendaDay >= today() ? agendaDay : "",
    };
    const p = editando;
    const ramos = DATA.Ramos.filter((r) => r.activo !== "No");
    const pct = num(ajustes().anticipo_pct) || 50;
    const yaPagado = base ? pagado(base) : 0;
    const abierto = !!base;
    let h = `<div class="sheethead"><button data-act="cerrar">Cancelar</button><b>${base ? "Editar pedido" : "Nuevo pedido"}</b><button data-act="guardar">Guardar</button></div><div class="sheetbody">`;
    h += `<div class="two"><label class="f"><span>¿Quién lo envía? *</span><input class="in" data-f="envia_nombre" value="${esc(p.envia_nombre)}" autocomplete="off"></label>
      <label class="f"><span>Su teléfono *</span><input class="in" data-f="envia_tel" type="tel" inputmode="tel" value="${esc(p.envia_tel)}" autocomplete="off"></label></div>`;
    h += `<label class="sw soft">No decir quién lo envía <input type="checkbox" class="toggle" data-f="anonimo" ${p.anonimo === "Sí" ? "checked" : ""}></label>`;
    h += `<label class="f"><span>¿Quién lo recibe?</span><input class="in" data-f="recibe_nombre" value="${esc(p.recibe_nombre)}" autocomplete="off"></label>`;
    h += `<div class="two"><label class="f"><span>Día</span><input class="in" type="date" data-f="fecha_entrega" value="${esc(p.fecha_entrega)}"></label>
      <label class="f"><span>Hora</span><input class="in" type="time" data-f="hora" value="${esc(p.hora)}"></label></div>`;
    h += `<label class="f"><span>Ramo</span><select class="in" data-f="ramo_id"><option value="">Escribir otro ramo…</option>${ramos.map((r) => `<option value="${esc(r.id)}" ${r.id === p.ramo_id ? "selected" : ""}>${esc(r.nombre)}</option>`).join("")}</select></label>`;
    h += `<label class="f" id="f-ramo-nombre" ${p.ramo_id ? "hidden" : ""}><span>Nombre del ramo</span><input class="in" data-f="ramo_nombre" value="${esc(p.ramo_id ? "" : p.ramo_nombre)}" placeholder="Ej. 50 rosas rojas" autocomplete="off"></label>`;
    h += `<div class="hint" id="f-sugerido"></div>`;
    h += `<div class="f"><span>Tipo</span>${chip("tipo", ["Sencillo", "Complejo"], p.tipo)}</div>`;
    h += `<label class="f"><span>Descripción / idea del ramo</span><textarea class="in" data-f="descripcion">${esc(p.descripcion)}</textarea></label>`;
    h += `<div class="f"><span>¿Por dónde llegó?</span>${chip("canal", ["WhatsApp", "Facebook", "Instagram", "Tienda"], p.canal)}</div>`;
    h += `<button type="button" class="drop" data-act="extras">Extras · tarjeta, listón, entrega, pago <span>${abierto ? "▴" : "▾"}</span></button>`;
    h += `<div class="extras" id="extras" ${abierto ? "" : "hidden"}>`;
    h += `<div class="sw">Tarjeta ${chip("tarjeta", ["Sí", "No", "Por preguntar"], p.tarjeta)}</div>`;
    h += `<input class="in" data-f="tarjeta_mensaje" value="${esc(p.tarjeta_mensaje)}" placeholder="Mensaje de la tarjeta" data-show="tarjeta">`;
    h += `<div class="sw">Listón en vinil ${chip("liston", ["Sí", "No", "Por preguntar"], p.liston)}</div>`;
    h += `<input class="in" data-f="liston_texto" value="${esc(p.liston_texto)}" placeholder="Texto del listón" data-show="liston">`;
    h += `<label class="sw" data-show="liston">Ya lo mandé a hacer <input type="checkbox" class="toggle" data-f="vinil_encargado" ${p.vinil_encargado === "Sí" ? "checked" : ""}></label>`;
    h += `<div class="lbl">Entrega</div>${chip("entrega", ["Tienda", "Envío"], p.entrega)}`;
    h += `<div data-show-envio>${chip("pueblo", ["Ezequiel Montes", "Tequisquiapan", "Otro"], p.pueblo)}</div>`;
    h += `<input class="in" data-f="pueblo_otro" value="${esc(p.pueblo_otro)}" placeholder="¿Qué pueblo?" data-show-otro>`;
    h += `<div class="two"><label class="f"><span>Precio del ramo</span><input class="in" data-f="precio_ramo" type="number" inputmode="numeric" min="0" value="${esc(p.precio_ramo)}"></label>
      <label class="f" data-show-envio><span>Costo de envío</span><input class="in" data-f="costo_envio" type="number" inputmode="numeric" min="0" value="${esc(p.costo_envio)}"></label></div>`;
    if (base && yaPagado > 0) {
      h += `<div class="info">Ya pagó ${money(yaPagado)}. Los demás pagos se registran al entregar.</div>`;
    } else {
      h += `<div class="two"><label class="f"><span>Anticipo (${pct}%)</span><input class="in" data-f="anticipo" type="number" inputmode="numeric" min="0" value="${esc(p.anticipo)}"></label>
        <div class="f"><span>Cómo pagó</span>${chip("anticipo_forma", ["Efectivo", "Transferencia"], p.anticipo_forma)}</div></div>`;
    }
    h += `<label class="f"><span>Notas</span><textarea class="in" data-f="notas">${esc(p.notas)}</textarea></label>`;
    h += `</div>`;
    h += `<button class="btn" data-act="guardar">Guardar pedido</button></div>`;
    openFull(h);
    actualizarFormulario();
  }

  // Lee lo que hay en pantalla y lo pasa al pedido en edición.
  function leerFormulario() {
    const p = editando;
    document.querySelectorAll("#full [data-f]").forEach((el) => {
      p[el.dataset.f] = el.type === "checkbox" ? (el.checked ? "Sí" : "No") : el.value.trim();
    });
    document.querySelectorAll("#full [data-chip]").forEach((g) => {
      const on = g.querySelector("button.on");
      p[g.dataset.chip] = on ? on.dataset.v : "";
    });
    const ramo = DATA.Ramos.find((r) => r.id === p.ramo_id);
    if (ramo) p.ramo_nombre = ramo.nombre;
    if (p.entrega !== "Envío") { p.pueblo = ""; p.pueblo_otro = ""; p.costo_envio = ""; }
    if (p.pueblo !== "Otro") p.pueblo_otro = "";
    return p;
  }

  // Muestra u oculta campos según lo elegido y sugiere precio y anticipo.
  function actualizarFormulario(cambio) {
    const p = leerFormulario();
    const show = (sel, on) => document.querySelectorAll("#full " + sel).forEach((el) => (el.hidden = !on));
    show("[data-show=tarjeta]", p.tarjeta === "Sí");
    show("[data-show=liston]", p.liston === "Sí");
    show("[data-show-envio]", p.entrega === "Envío");
    show("[data-show-otro]", p.entrega === "Envío" && p.pueblo === "Otro");
    $("#f-ramo-nombre").hidden = !!p.ramo_id;

    const ramo = DATA.Ramos.find((r) => r.id === p.ramo_id);
    const hist = ramo && historialPrecio(ramo.id);
    const sugerido = hist ? hist.ultimo : ramo ? num(ramo.precio_lista) : 0;
    $("#f-sugerido").textContent = ramo
      ? `Sugerido ${money(sugerido)}` + (hist ? ` · la última vez ${money(hist.ultimo)} · promedio ${money(hist.promedio)} (${hist.veces} ${hist.veces === 1 ? "vez" : "veces"})` : " · precio de lista")
      : "";
    const precio = document.querySelector('#full [data-f="precio_ramo"]');
    if (cambio === "ramo_id" && ramo) {
      if (sugerido) precio.value = sugerido;
      if (ramo.tipo) document.querySelectorAll('#full [data-chip="tipo"] button').forEach((b) => b.classList.toggle("on", b.dataset.v === ramo.tipo));
    }
    const anticipo = document.querySelector('#full [data-f="anticipo"]');
    if (anticipo && (cambio === "ramo_id" || cambio === "precio_ramo" || cambio === "costo_envio") && !anticipo.dataset.manual) {
      const pct = num(ajustes().anticipo_pct) || 50;
      const total = num(precio.value) + (p.entrega === "Envío" ? num(document.querySelector('#full [data-f="costo_envio"]').value) : 0);
      anticipo.value = total ? Math.round((total * pct) / 100) : "";
    }
  }

  async function guardarFormulario(btn) {
    const p = leerFormulario();
    if (!p.envia_nombre || !p.envia_tel) return toast("Falta quién lo envía y su teléfono.", true);
    const nuevo = !DATA.Pedidos.some((x) => x.id === p.id);
    const anticipo = num(p.anticipo);
    if (anticipo > 0 && !p.anticipo_forma) return toast("Elige cómo pagó el anticipo.", true);
    await conEspera(btn, async () => {
      const calOk = await guardarPedido(p, nuevo);
      if (anticipo > 0 && pagado(p) === 0) await registrarPago(p, "Anticipo", anticipo, p.anticipo_forma);
      await recargar();
      closeFull();
      toast(calOk ? "Pedido guardado" : "Pedido guardado, pero no se pudo poner el aviso en el calendario.", !calOk);
    });
  }

  // Cambia el estado del pedido y lo guarda; con cobro si se entrega con saldo pendiente.
  async function cambiarEstado(btn, id, estado, forma) {
    const p = { ...DATA.Pedidos.find((x) => x.id === id) };
    const falta = totalDe(p) - pagado(p);
    await conEspera(btn, async () => {
      if (estado === "Entregado" && falta > 0) await registrarPago(p, "Liquidación", falta, forma);
      p.estado = estado;
      const calOk = await guardarPedido(p, false);
      await recargar();
      abrirFicha(id);
      toast(calOk ? "Listo" : "Guardado, pero no se pudo actualizar el calendario.", !calOk);
    });
  }

  async function conEspera(btn, fn) {
    const botones = document.querySelectorAll("#full button");
    botones.forEach((b) => (b.disabled = true));
    const txt = btn && btn.textContent;
    if (btn) btn.textContent = "Guardando…";
    try {
      await fn();
    } catch (e) {
      if (e instanceof AuthError) { closeFull(); remove(TOKEN_KEY); return showLogin("Tu sesión terminó. Vuelve a entrar y repite el cambio."); }
      toast(e.message, true);
      // Vuelve a leer la hoja para que un segundo intento no duplique lo que sí se alcanzó a guardar.
      await recargar().catch(() => {});
      if (fichaId && $("#full").querySelector('[data-act="editar"]')) abrirFicha(fichaId);
    } finally {
      botones.forEach((b) => (b.disabled = false));
      if (btn && btn.isConnected) btn.textContent = txt;
    }
  }

  // ---------- Eventos de la pantalla ----------

  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-act], [data-id], #full [data-chip] button");
    if (!el) return;
    if (el.parentElement && el.parentElement.dataset.chip) {
      const yaOn = el.classList.contains("on");
      el.parentElement.querySelectorAll("button").forEach((b) => b.classList.remove("on"));
      if (!yaOn) el.classList.add("on");
      return actualizarFormulario(el.parentElement.dataset.chip);
    }
    const act = el.dataset.act;
    const id = el.dataset.id;
    if (!act && id) return abrirFicha(id);
    if (act === "nuevo") return abrirFormulario();
    if (act === "cerrar") return closeFull();
    if (act === "editar") return abrirFormulario(id);
    if (act === "guardar") return guardarFormulario(el);
    if (act === "extras") {
      const x = $("#extras");
      x.hidden = !x.hidden;
      el.querySelector("span").textContent = x.hidden ? "▾" : "▴";
      return;
    }
    if (act === "vista") { agendaView = el.dataset.v; return render(); }
    if (act === "dia") { agendaDay = el.dataset.v; return render(); }
    if (act === "mes") {
      const d = new Date(agendaMonth + "-15T12:00:00Z");
      d.setUTCMonth(d.getUTCMonth() + Number(el.dataset.v));
      agendaMonth = d.toISOString().slice(0, 7);
      agendaDay = agendaMonth === today().slice(0, 7) ? today() : agendaMonth + "-01";
      return render();
    }
    if (act === "entregar") return cambiarEstado(el, id, "Entregado", el.dataset.v);
    if (act === "estado") return cambiarEstado(el, id, el.dataset.v);
    if (act === "cancelar") {
      if (confirm("¿Cancelar este pedido? El anticipo no se devuelve y se borran sus avisos del calendario.")) cambiarEstado(el, id, "Cancelado");
      return;
    }
    if (act === "vinil") {
      const p = { ...DATA.Pedidos.find((x) => x.id === id), vinil_encargado: "Sí" };
      return conEspera(el, async () => {
        await guardarPedido(p, false);
        await recargar();
        abrirFicha(id);
        toast("Anotado: el vinil ya está encargado");
      });
    }
  });

  document.addEventListener("input", (ev) => {
    const f = ev.target.dataset && ev.target.dataset.f;
    if (!f || $("#full").hidden) return;
    if (f === "anticipo") ev.target.dataset.manual = "1";
    if (["ramo_id", "precio_ramo", "costo_envio"].includes(f)) actualizarFormulario(f);
  });
  document.addEventListener("change", (ev) => {
    if (ev.target.dataset && ev.target.dataset.f === "ramo_id") actualizarFormulario("ramo_id");
  });

  // ---------- Arranque ----------

  function showLogin(msg) {
    $("#app").hidden = true;
    $("#login").hidden = false;
    $("#login-msg").textContent = msg || "";
  }

  async function recargar() {
    DATA = await loadSheet();
    render();
  }

  async function start() {
    $("#login").hidden = true;
    $("#app").hidden = false;
    render();
    try {
      await recargar();
    } catch (e) {
      if (e instanceof AuthError) { remove(TOKEN_KEY); return showLogin("Tu sesión terminó. Vuelve a entrar."); }
      $("#view").innerHTML = `<div class="error">${esc(e.message)}</div>`;
    }
  }

  $("#btn-login").onclick = login;
  $("#btn-ajustes").onclick = () => { tab = "ajustes"; render(); };
  document.querySelectorAll(".nav button").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));

  // Al volver a abrir la app después de un rato, recarga los datos (si no hay un pedido a medio llenar).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && DATA && $("#full").hidden) {
      if (!getToken()) return showLogin("Tu sesión terminó. Vuelve a entrar.");
      recargar().catch(() => {});
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
