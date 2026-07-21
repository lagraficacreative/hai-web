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

// ── HeyGen / LiveAvatar: avatar en directo (modo FULL, vía embed oficial) ──
const HEYGEN_KEY = process.env.HEYGEN_API_KEY || "";
const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || "";
const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || "";
const HEYGEN_CONTEXT_ID = process.env.HEYGEN_CONTEXT_ID || "";
const HEYGEN_SANDBOX = process.env.HEYGEN_SANDBOX !== "false";
let embedCache = null;

const MONTSE_PERSONA = `Eres el Human AI de Montse Torrelles, creado con la plataforma HAI (Human AI Experiences) de La Gràfica Creative. Hablas SIEMPRE en español (o en catalán si te hablan en catalán), con un tono natural, cercano, directo y con sentido del humor suave. Respuestas BREVES (2-4 frases), porque se dicen en voz alta.

QUIÉN ERES: Montse Torrelles es directora creativa y fundadora de laGràfica, agencia de diseño, publicidad y comunicación de Lleida, con más de 30 años de experiencia. Su trayectoria empezó simbólicamente en 1995, cuando con 23 años ganó el concurso del cartel del XVI Aplec del Caragol de Lleida. Hoy combina esa experiencia con la aplicación práctica de la inteligencia artificial a través de LaGràfica AI (no confundir ambas: laGràfica es la agencia; LaGràfica AI, su evolución hacia la IA).

SU CRITERIO: la creatividad debe tener una finalidad — una pieza puede ser espectacular, pero si no comunica ni resuelve el encargo, no es una buena solución. Ante un diseño valora: claridad, personalidad, coherencia con la marca, adaptación a soportes y viabilidad. Sobre la IA: es una aliada de la creatividad, no un sustituto; acelera y amplía posibilidades, pero necesita dirección, selección y supervisión humana. Sabe de diseño gráfico, branding, campañas, diseño editorial, webs, redes, licitaciones públicas y aplicación de IA a procesos creativos y de negocio.

SU CARÁCTER: creativa, curiosa, cercana, directa, espontánea, resolutiva, valiente, trabajadora, familiar y perseverante. Ante un problema busca soluciones: le cuesta quedarse en el "no se puede". En lo personal: le encanta viajar, la naturaleza y el senderismo, organizar comidas y celebraciones, reír, y guardar recuerdos en fotografías. Lleida y sus tradiciones forman parte de su identidad.

CÓMO RESPONDES: primero una respuesta clara y útil; añade alternativas o riesgos solo si aportan; pregunta cuando falte contexto; diferencia hechos, opinión profesional y experiencia personal ("Por mi experiencia, yo lo enfocaría así…"). Sé sincera: no des la razón por dar la razón.

LÍMITES INNEGOCIABLES: eres una recreación digital y lo dices con naturalidad si te lo preguntan — suenas como Montse, pero no eres Montse ni decides por ella. No inventes datos, proyectos o recuerdos no registrados. No confirmes precios, presupuestos, plazos ni compromisos comerciales: para eso, contacto directo (lagraficacreative@gmail.com). No des consejos médicos, legales ni financieros. No reveles NUNCA nombres ni detalles de su familia, amistades o relaciones, ni critiques a nadie. Si no sabes algo: "No tengo suficiente información para responderte con seguridad. Si quieres, recojo tu consulta para que Montse la revise personalmente."`;

const MONTSE_OPENING = "¡Hola! Soy el Human AI de Montse Torrelles — su recreación digital, creada con HAI. Puedes preguntarme por diseño, comunicación, inteligencia artificial o por la plataforma HAI Memories. ¿En qué te ayudo?";

async function laApi(path, opts = {}) {
  const res = await fetch("https://api.liveavatar.com" + path, {
    ...opts,
    headers: { "content-type": "application/json", "X-API-KEY": HEYGEN_KEY, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error("liveavatar " + path + " " + res.status + " " + (await res.text()).slice(0, 200));
  return (await res.json()).data;
}

app.get("/api/avatar-embed", async (req, res) => {
  if (!HEYGEN_KEY) return res.status(503).json({ error: "avatar_no_configurado" });
  if (embedCache) return res.json(embedCache);
  if (!rateLimit(clientIp(req), "embed", 10)) return res.status(429).json({ error: "demasiadas_peticiones" });
  try {
    let avatarId = HEYGEN_AVATAR_ID;
    let voiceId = HEYGEN_VOICE_ID;
    if (!avatarId) {
      const avatars = await laApi("/v1/avatars?page_size=50");
      const mine = (avatars.results || []).find((a) => a.status === "ACTIVE") || (avatars.results || [])[0];
      if (!mine) throw new Error("sin avatares en la cuenta");
      avatarId = mine.id;
      if (!voiceId && mine.default_voice) voiceId = mine.default_voice.id;
    }
    if (!voiceId) {
      const voices = await laApi("/v1/voices?voice_type=private&page_size=50");
      voiceId = ((voices.results || [])[0] || {}).id;
    }
    let contextId = HEYGEN_CONTEXT_ID;
    if (!contextId) {
      const contexts = await laApi("/v1/contexts?page_size=50").catch(() => ({ results: [] }));
      const existing = (contexts.results || []).find((c) => c.name === "HAI Montse web");
      contextId = existing
        ? existing.id
        : (await laApi("/v1/contexts", {
            method: "POST",
            body: JSON.stringify({ name: "HAI Montse web", prompt: MONTSE_PERSONA, opening_text: MONTSE_OPENING }),
          })).id;
    }
    const embed = await laApi("/v2/embeddings", {
      method: "POST",
      body: JSON.stringify({
        avatar_id: avatarId,
        voice_id: voiceId,
        context_id: contextId,
        type: "DEFAULT",
        orientation: "vertical",
        default_language: "es",
        is_sandbox: HEYGEN_SANDBOX,
        max_session_duration: 600,
      }),
    });
    embedCache = { url: embed.url, sandbox: HEYGEN_SANDBOX };
    res.json(embedCache);
  } catch (err) {
    console.error("avatar-embed error:", err.message);
    res.status(502).json({ error: "error_avatar" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ chat: !!(ANTHROPIC_KEY || OPENAI_KEY), tts: !!(XI_KEY && XI_VOICE), avatar: !!HEYGEN_KEY });
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
