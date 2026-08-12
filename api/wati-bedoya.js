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

const WELCOME = {
  header: "García Bedoya 172",
  body: "Hola. Gracias por escribirnos sobre García Bedoya 172, Miraflores.\n\nSoy el asistente de CP Inmobiliaria. ¿Qué te gustaría recibir?",
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
  body: "¿Deseas algo más?",
  buttons: [{ text: "Hablar con asesor" }, { text: "Ver opciones" }],
};

const CONTENT = {
  brochure: "Aquí está el brochure de García Bedoya 172:\n\n" + BROCHURE_URL,
  precios: "Aquí está la lista de precios actualizada de García Bedoya 172.\n\nAl estar en inicio de obra, estos son los precios más competitivos que tendrá el proyecto — se actualizan a medida que avanza la construcción.\n\n" + PRECIOS_URL,
  avances: "Esta es la presentación más reciente de avances de García Bedoya 172.\n\nEstamos en inicio de obra.\n\n" + AVANCES_URL,
  asesor: "Perfecto. Un asesor de CP Inmobiliaria se pondrá en contacto contigo en los próximos minutos.\n\nHorario de atención: lunes a sábado de 9am a 7pm.",
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
async function sendContent(num, key) { await sendText(num, CONTENT[key]); await sendButtons(num, FOLLOWUP); }
async function sendAsesor(num)  { await sendText(num, CONTENT.asesor); } // handoff: queda en el inbox de WATI para un humano

// ── Reconocimiento de intención (lista/botón/texto libre) ──
function matchIntent(raw) {
  const t = (raw || "").toLowerCase().trim();
  if (!t) return "welcome";
  if (/\b(menú|menu|inicio|opciones|volver|hola|buenas|informaci[oó]n|info|empezar|start)\b/.test(t)) return "welcome";
  if (t.includes("brochure") || t.includes("folleto")) return "brochure";
  if (t.includes("precio")) return "precios";
  if (t.includes("avance") || t.includes("obra")) return "avances";
  if (t.includes("asesor") || t.includes("contact") || t.includes("llam") || t.includes("hablar") || t.includes("vendedor")) return "asesor";
  return "unknown";
}

// ── Extrae remitente + texto del payload del webhook (defensivo) ──
function parseEvent(b) {
  b = b || {};
  const num = b.waId || b.wAid || b.whatsappNumber ||
              (b.contact && (b.contact.wAid || b.contact.waId)) || null;
  const text =
    (b.listReply && b.listReply.title) ||
    (b.interactiveButtonReply && b.interactiveButtonReply.text) ||
    (b.buttonReply && (b.buttonReply.text || b.buttonReply.title)) ||
    b.text || "";
  const eventType = b.eventType || b.type || "";
  return { num, text, eventType, owner: b.owner };
}

module.exports = async (req, res) => {
  if (req.method === "GET")  return res.status(200).send("wati-bedoya bot OK");
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }

  const { num, text, eventType, owner } = parseEvent(body);

  // Solo mensajes ENTRANTES del cliente (owner === false). Ignora salientes/otros eventos.
  if (owner === true || owner === "true") return res.status(200).json({ skipped: "outbound" });
  if (!num) return res.status(200).json({ skipped: "no-number" });

  // Guardrail modo prueba: solo números en la allowlist
  if (TEST_MODE && !ALLOWLIST.includes(String(num))) {
    return res.status(200).json({ skipped: "not-allowlisted", num });
  }

  const intent = matchIntent(text);

  if (DEBUG) {
    await sendText(num, `DEBUG · text="${String(text).slice(0,40)}" · intent=${intent} · event=${eventType}`);
  }

  try {
    if (intent === "asesor")                         await sendAsesor(num);
    else if (intent === "brochure" || intent === "precios" || intent === "avances")
                                                     await sendContent(num, intent);
    else                                             await sendWelcome(num); // welcome | unknown
    return res.status(200).json({ ok: true, intent, num });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e).slice(0, 200) });
  }
};
