// ─────────────────────────────────────────────────────────────────────────────
// WATI webhook bot · García Bedoya 172 (CP Inmobiliaria)
// Router sin estado: cada mensaje/selección entrante mapea a una respuesta.
// Guardrails: modo prueba (allowlist) + solo reacciona a mensajes entrantes.
//
// Variables de entorno (Vercel):
//   WATI_API_ENDPOINT   https://live-mt-server.wati.io/10219370
//   WATI_API_TOKEN      (secreto — Bearer token de WATI)
//   BOT_TEST_MODE       "true"  -> solo responde a números en BOT_ALLOWLIST
//   BOT_ALLOWLIST       "34654566186"  (coma-separado)
//   BOT_DEBUG           "true"  -> además devuelve lo que parseó (para diagnóstico)
// ─────────────────────────────────────────────────────────────────────────────

const ENDPOINT  = (process.env.WATI_API_ENDPOINT || "").replace(/\/+$/, "");
const TOKEN     = process.env.WATI_API_TOKEN || "";
const TEST_MODE = (process.env.BOT_TEST_MODE || "true").toLowerCase() === "true";
const DEBUG     = (process.env.BOT_DEBUG || "false").toLowerCase() === "true";
const ALLOWLIST = (process.env.BOT_ALLOWLIST || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// ── Contenido (copy final, sin emoji) ──
const BROCHURE_URL = "https://drive.google.com/file/d/1AfC8lADIzmgzNY6_2B_RZcwYY3uarGwH/view";
const PRECIOS_URL  = "https://www.cpinmobiliaria.com/docs/lista-precios-bedoya.pdf";
const AVANCES_URL  = "https://www.cpinmobiliaria.com/docs/avances-bedoya-julio-2026.pdf";
const VIDEO_URL    = "https://www.cpinmobiliaria.com/assets/videos/bedoya-172.mp4";

const WELCOME = {
  header: "CP Inmobiliaria",
  body: "Hola. Gracias por su interés en García Bedoya 172, Miraflores.\n\nSoy el asistente virtual de CP Inmobiliaria. ¿Qué le gustaría recibir?",
  footer: "CP Inmobiliaria",
  buttonText: "Ver opciones",
  sections: [{ title: "Opciones", rows: [
    { title: "Brochure" },
    { title: "Lista de precios" },
    { title: "Avances de obra" },
    { title: "Hablar con asesor" },
  ]}],
};

const FOLLOWUP = {
  body: "¿Desea algo más?",
  footer: "CP Inmobiliaria",
  buttonText: "Ver opciones",
  sections: [{ title: "Opciones", rows: [
    { title: "Hablar con asesor" },
    { title: "Brochure" },
    { title: "Lista de precios" },
    { title: "Avances de obra" },
  ]}],
};

const CONTENT = {
  brochure: "Aquí está el brochure de García Bedoya 172:\n\n" + BROCHURE_URL,
  precios: "Aquí está la lista de precios actualizada de García Bedoya 172.\n\nAl estar en inicio de obra, estos son los precios más competitivos que tendrá el proyecto — se actualizan a medida que avanza la construcción.\n\n" + PRECIOS_URL,
  avances: "Esta es la presentación más reciente de avances de García Bedoya 172.\n\nEstamos en inicio de obra.\n\n" + AVANCES_URL,
  asesor: "Perfecto. Un asesor de CP Inmobiliaria se pondrá en contacto con usted a la brevedad.",
  closing: "Gracias por contactarnos. No dude en escribirnos nuevamente ante cualquier duda o consulta. Que tenga un excelente día.",
};

// ── Helpers de la API de WATI ──
async function watiPost(path, { query = {}, json } = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = ENDPOINT + path + (qs ? "?" + qs : "");
  return fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: json ? JSON.stringify(json) : undefined,
  });
}
const sendText    = (num, text) => watiPost("/api/v1/sendSessionMessage/" + num, { query: { messageText: text } });
const sendList    = (num, list) => watiPost("/api/v1/sendInteractiveListMessage",    { query: { whatsappNumber: num }, json: list });
const sendButtons = (num, btns) => watiPost("/api/v1/sendInteractiveButtonsMessage", { query: { whatsappNumber: num }, json: btns });

async function sendWelcome(num) { await sendList(num, WELCOME); }
async function sendContent(num, key) { await sendText(num, CONTENT[key]); await sendList(num, FOLLOWUP); }
async function sendAsesor(num)  { await sendText(num, CONTENT.asesor); } // handoff: queda en el inbox de WATI para un humano

// Enviar video (descarga del sitio y sube a WATI por multipart)
async function sendVideo(num) {
  const r = await fetch(VIDEO_URL);
  const buf = Buffer.from(await r.arrayBuffer());
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "video/mp4" }), "bedoya-172.mp4");
  await fetch(ENDPOINT + "/api/v1/sendSessionFile/" + num, {
    method: "POST", headers: { Authorization: "Bearer " + TOKEN }, body: fd,
  });
}
// Estado por contacto (para enviar el video una sola vez)
async function getContact(num) {
  try {
    const r = await fetch(ENDPOINT + "/api/v1/getContacts?pageSize=100&pageNumber=1",
      { headers: { Authorization: "Bearer " + TOKEN } });
    const j = await r.json();
    return (j.contact_list || []).find(x => String(x.wAid) === String(num)) || null;
  } catch (e) { return null; }
}
function attrVal(contact, name) {
  const p = ((contact && contact.customParams) || []).find(x => x.name === name);
  return p ? p.value : null;
}
async function setContactAttr(num, name, value) {
  try {
    await fetch(ENDPOINT + "/api/v1/updateContactAttributes/" + num, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ customParams: [{ name, value }] }),
    });
  } catch (e) {}
}

// ── Reconocimiento de intención (lista/botón/texto libre) ──
function matchIntent(raw) {
  const t = (raw || "").toLowerCase().trim();
  if (!t) return "welcome";
  if (t.includes("brochure") || t.includes("folleto")) return "brochure";
  if (t.includes("precio")) return "precios";
  if (t.includes("avance") || t.includes("obra")) return "avances";
  if (t.includes("asesor") || t.includes("contact") || t.includes("llam") || t.includes("hablar") || t.includes("vendedor")) return "asesor";
  if (/\b(menú|menu|inicio|opciones|volver|hola|buenas|informaci[oó]n|info|empezar|start)\b/.test(t)) return "welcome";
  // Despedida / agradecimiento tras el flujo → cierre profesional (no re-saludar)
  if (t.includes("gracias") || /(eso es todo|es todo|nada m[aá]s|est[aá] bien|ya est[aá])/.test(t) ||
      ["no", "no gracias", "listo", "ok", "okay", "perfecto", "ya"].includes(t)) return "closing";
  return "unknown";
}

// ── Extrae remitente + texto del payload del webhook (defensivo) ──
function parseEvent(b) {
  b = b || {};
  const num = b.waId || b.wAid || b.whatsappNumber ||
              (b.contact && (b.contact.wAid || b.contact.waId)) || null;
  const id = b.id || b.whatsappMessageId || b.messageId || b.eventId || null; // para dedup de reintentos
  const text =
    (b.listReply && b.listReply.title) ||
    (b.interactiveButtonReply && b.interactiveButtonReply.text) ||
    (b.buttonReply && (b.buttonReply.text || b.buttonReply.title)) ||
    b.text || "";
  const eventType = b.eventType || b.type || "";
  return { num, text, eventType, owner: b.owner, id };
}

module.exports = async (req, res) => {
  if (req.method === "GET")  return res.status(200).send("wati-bedoya bot OK");
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  try { console.log("WH", JSON.stringify(body).slice(0, 700)); } catch (e) {} // TEMP: inspeccionar payload real

  const { num, text, eventType, owner, id: msgId } = parseEvent(body);

  // Solo mensajes ENTRANTES del cliente CON contenido.
  if (owner === true || owner === "true") return res.status(200).json({ skipped: "outbound" });
  if (!num) return res.status(200).json({ skipped: "no-number" });
  // Ignorar eventos sin texto (avisos de estado/entrega, etc.) — evita respuestas espurias.
  if (!String(text || "").trim()) return res.status(200).json({ skipped: "empty-event" });

  // Guardrail modo prueba: solo números en la allowlist
  if (TEST_MODE && !ALLOWLIST.includes(String(num))) {
    return res.status(200).json({ skipped: "not-allowlisted", num });
  }

  // Leer el contacto una vez (pausa total + handoff + estado del video)
  const contact = await getContact(num);
  // Conversación 100% humana (contactos existentes): el bot NO interviene en nada.
  if (attrVal(contact, "bot_paused") === "true") {
    return res.status(200).json({ skipped: "paused", num });
  }
  // Dedup: ignora reintentos del webhook (mismo mensaje) para no duplicar respuestas
  if (msgId && attrVal(contact, "last_msg") === String(msgId)) {
    return res.status(200).json({ skipped: "duplicate", num });
  }
  if (msgId) await setContactAttr(num, "last_msg", String(msgId));

  const intent = matchIntent(text);
  const handoff = attrVal(contact, "bot_handoff") === "true";

  try {
    if (intent === "brochure" || intent === "precios" || intent === "avances") {
      await sendContent(num, intent); // auto-servicio: funciona siempre, incluso tras pedir asesor
    } else if (intent === "asesor") {
      await sendAsesor(num);
      await setContactAttr(num, "bot_handoff", "true"); // pidió asesor: el bot deja de re-saludar
    } else if (intent === "closing") {
      if (!handoff) await sendText(num, CONTENT.closing); // despedida; tras handoff, deja al humano
    } else {
      // welcome | unknown
      if (handoff) {
        return res.status(200).json({ skipped: "handoff-no-welcome", num }); // ya pidió asesor: no re-saludar
      }
      // primer contacto → video una sola vez, luego la bienvenida
      if (attrVal(contact, "bot_video_sent") !== "true") {
        await sendVideo(num);
        await setContactAttr(num, "bot_video_sent", "true");
      }
      await sendWelcome(num);
    }
    return res.status(200).json({ ok: true, intent, num });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e).slice(0, 200) });
  }
};
