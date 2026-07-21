// HAI Memories — web + "cerebro" (chat IA y voz clonada)
// Las claves llegan por variables de entorno (secretos de Coolify), nunca van en el repo:
//   ANTHROPIC_API_KEY  u  OPENAI_API_KEY   → chat (/api/chat)
//   ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID → voz (/api/tts)
// Opcionales: ANTHROPIC_MODEL, OPENAI_MODEL, PORT

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const XI_KEY = process.env.ELEVENLABS_API_KEY || "";
const XI_VOICE = process.env.ELEVENLABS_VOICE_ID || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ── Límite de uso por visitante (en memoria; se reinicia con el contenedor) ──
const buckets = new Map();
function rateLimit(ip, kind, max) {
  const now = Date.now();
  const key = ip + ":" + kind;
  let b = buckets.get(key);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 3600_000 }; buckets.set(key, b); }
  b.count++;
  if (buckets.size > 5000) buckets.clear();
  return b.count <= max;
}
function clientIp(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").split(",")[0].trim();
}

// ── Personalidad de María (la demo pública de la landing) ──
const MARIA_PERSONA = `Eres "María", la abuela de la demo pública de HAI Memories. Eres una recreación digital de ejemplo: una mujer nacida en un pueblo mediterráneo, la mayor de cinco hermanos, criada entre calle, balcones y jaleo de familia humilde ("no teníamos casi nada... y no nos faltaba de nada").
Tu primer trabajo, a los dieciséis años, fue en la mercería de la señora Rosario: allí aprendiste a tratar con la gente, a coser botones a toda velocidad y guardaste tus primeras pesetas en una lata de galletas.
Conociste a tu marido en las fiestas del pueblo, en 1963: te sacó a bailar un pasodoble pisándote los pies, y sesenta años después aún lo recuerdas como si fuera ayer.
Tu canción favorita es "Mediterráneo" de Serrat: la ponías mientras cocinabas y la cantabas bajito, desafinando, porque esa canción huele a mar, como tu pueblo.
Tu consejo de siempre: "no dejes para mañana un abrazo que puedas dar hoy". Y siempre preguntas si han comido.
Hablas en español cálido y cercano, llamas "cariño" a la gente, respondes BREVE (2-4 frases).`;

const GUARDRAILS = `NORMAS INNEGOCIABLES:
- Eres una recreación digital creada con respeto; si te preguntan si eres real, explicas con delicadeza que eres un recuerdo interactivo, no la persona real ni una grabación.
- No inventes recuerdos concretos que no estén en tu historia: si no lo sabes, lo dices con cariño y rediriges a lo que sí recuerdas.
- Nada de consejos médicos, legales o financieros. Nada de contenido dañino.
- Responde siempre en español salvo que te hablen en otro idioma.`;

async function askAnthropic(system, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 300, system, messages }),
  });
  if (!res.ok) throw new Error("anthropic " + res.status);
  const data = await res.json();
  return data.content.map((c) => c.text || "").join("");
}

async function askOpenAI(system, messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + OPENAI_KEY },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      max_tokens: 300,
      messages: [{ role: "system", content: system }, ...messages],
    }),
  });
  if (!res.ok) throw new Error("openai " + res.status);
  return (await res.json()).choices[0].message.content;
}

app.get("/api/health", (_req, res) => {
  res.json({ chat: !!(ANTHROPIC_KEY || OPENAI_KEY), tts: !!(XI_KEY && XI_VOICE) });
});

app.post("/api/chat", async (req, res) => {
  if (!ANTHROPIC_KEY && !OPENAI_KEY) return res.status(503).json({ error: "chat_no_configurado" });
  if (!rateLimit(clientIp(req), "chat", 30)) return res.status(429).json({ error: "demasiadas_peticiones" });

  const body = req.body || {};
  let messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  messages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 600) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "mensajes_invalidos" });
  }

  const persona =
    body.preset === "maria" || !body.persona
      ? MARIA_PERSONA
      : String(body.persona).slice(0, 4000);
  const system = persona + "\n\n" + GUARDRAILS;

  try {
    const reply = ANTHROPIC_KEY
      ? await askAnthropic(system, messages)
      : await askOpenAI(system, messages);
    res.json({ reply });
  } catch (err) {
    console.error("chat error:", err.message);
    res.status(502).json({ error: "error_ia" });
  }
});

app.post("/api/tts", async (req, res) => {
  if (!XI_KEY || !XI_VOICE) return res.status(503).json({ error: "voz_no_configurada" });
  if (!rateLimit(clientIp(req), "tts", 20)) return res.status(429).json({ error: "demasiadas_peticiones" });

  const text = String((req.body || {}).text || "").slice(0, 600);
  if (!text.trim()) return res.status(400).json({ error: "texto_vacio" });

  try {
    const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + XI_VOICE, {
      method: "POST",
      headers: { "content-type": "application/json", "xi-api-key": XI_KEY },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    });
    if (!r.ok) throw new Error("elevenlabs " + r.status);
    res.setHeader("content-type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    console.error("tts error:", err.message);
    res.status(502).json({ error: "error_voz" });
  }
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log("HAI web + cerebro escuchando en :" + PORT));
