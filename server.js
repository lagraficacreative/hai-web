// HAI Memories — web + "cerebro" (chat IA, voz clonada, avatar en directo y cuentas de usuario)
// Las claves llegan por variables de entorno (secretos de Coolify), nunca van en el repo:
//   ANTHROPIC_API_KEY  u  OPENAI_API_KEY   → chat (/api/chat y chat privado)
//   ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID → voz (/api/tts)
//   HEYGEN_API_KEY → avatar en directo (/api/avatar-embed)
//   SESSION_SECRET → firma de sesiones (recomendado fijarlo)
// Datos de usuarios en SQLite: DATA_DIR (montar volumen persistente en Coolify → /app/data)

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const app = express();
app.use((_req, res, next) => {
  // Endurecimiento básico (Fase 5); sin CSP porque la web usa scripts inline
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(express.json({ limit: "600kb" }));
app.use(express.static(path.join(__dirname, "public")));

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const XI_KEY = process.env.ELEVENLABS_API_KEY || "";
const XI_VOICE = process.env.ELEVENLABS_VOICE_ID || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

// ── Base de datos (SQLite integrada en Node, sin dependencias nativas) ──
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "hai.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS humans (
    user_id INTEGER PRIMARY KEY,
    name TEXT NOT NULL DEFAULT 'Mi Human AI',
    bio TEXT NOT NULL DEFAULT '',
    photo TEXT NOT NULL DEFAULT '',
    voice_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, id);
  CREATE TABLE IF NOT EXISTS intake (
    user_id INTEGER PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    submitted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, id);
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sector TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS avatars (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'es',
    personality TEXT NOT NULL DEFAULT '',
    voice_id TEXT NOT NULL DEFAULT '',
    agent_id TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'normal',
    status TEXT NOT NULL DEFAULT 'draft',
    consent TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "lagraficacreative@gmail.com")
  .toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
const USER_QUOTA_BYTES = Number(process.env.USER_QUOTA_MB || 500) * 1024 * 1024;
function isAdmin(user) { return ADMIN_EMAILS.includes((user.email || "").toLowerCase()); }

// ── Contraseñas (scrypt) y sesiones (cookie httpOnly) ──
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(pw, salt, 64).toString("hex");
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(pw, salt, 64);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}
function signToken(raw) {
  return raw + "." + crypto.createHmac("sha256", SESSION_SECRET).update(raw).digest("hex").slice(0, 32);
}
function verifyToken(signed) {
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const raw = signed.slice(0, i);
  return signToken(raw) === signed ? raw : null;
}
function setSession(res, userId) {
  const raw = crypto.randomBytes(24).toString("hex");
  db.prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(raw, userId);
  res.setHeader("Set-Cookie", `hai_session=${signToken(raw)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure`);
}
function currentUser(req) {
  const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith("hai_session="));
  if (!cookie) return null;
  const raw = verifyToken(cookie.slice("hai_session=".length));
  if (!raw) return null;
  const row = db.prepare(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
  ).get(raw);
  return row || null;
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { res.status(401).json({ error: "no_autenticado" }); return null; }
  return user;
}

// ── Límite de uso (en memoria) ──
const buckets = new Map();
function rateLimit(key, kind, max) {
  const now = Date.now();
  const k = key + ":" + kind;
  let b = buckets.get(k);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 3600_000 }; buckets.set(k, b); }
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

async function askLLM(system, messages) {
  return ANTHROPIC_KEY ? askAnthropic(system, messages) : askOpenAI(system, messages);
}

async function elevenlabsTts(text, voiceId) {
  const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voiceId, {
    method: "POST",
    headers: { "content-type": "application/json", "xi-api-key": XI_KEY },
    body: JSON.stringify({
      text,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });
  if (!r.ok) throw new Error("elevenlabs " + r.status + " " + (await r.text()).slice(0, 300));
  return Buffer.from(await r.arrayBuffer());
}

// ── Cuentas de usuario ──
app.post("/api/auth/register", (req, res) => {
  if (!rateLimit(clientIp(req), "register", 10)) return res.status(429).json({ error: "demasiadas_peticiones" });
  const { email, password, name } = req.body || {};
  const mail = String(email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) return res.status(400).json({ error: "email_invalido" });
  if (typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "password_corta" });
  try {
    const info = db.prepare("INSERT INTO users (email, password, name) VALUES (?, ?, ?)").run(
      mail, hashPassword(password), String(name || "").slice(0, 80)
    );
    setSession(res, Number(info.lastInsertRowid));
    res.json({ ok: true });
  } catch (e) {
    res.status(409).json({ error: "email_ya_registrado" });
  }
});

app.post("/api/auth/login", (req, res) => {
  if (!rateLimit(clientIp(req), "login", 20)) return res.status(429).json({ error: "demasiadas_peticiones" });
  const { email, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase());
  if (!user || !checkPassword(String(password || ""), user.password)) {
    return res.status(401).json({ error: "credenciales_invalidas" });
  }
  setSession(res, user.id);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith("hai_session="));
  if (cookie) {
    const raw = verifyToken(cookie.slice("hai_session=".length));
    if (raw) db.prepare("DELETE FROM sessions WHERE token = ?").run(raw);
  }
  res.setHeader("Set-Cookie", "hai_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "no_autenticado" });
  res.json({ user });
});

// ── El Human AI privado de cada usuario ──
app.get("/api/human", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const human = db.prepare("SELECT name, bio, photo, voice_id FROM humans WHERE user_id = ?").get(user.id) ||
    { name: "Mi Human AI", bio: "", photo: "", voice_id: "" };
  res.json({ human });
});

app.put("/api/human", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const b = req.body || {};
  const name = String(b.name || "Mi Human AI").slice(0, 80);
  const bio = String(b.bio || "").slice(0, 8000);
  const photo = String(b.photo || "").slice(0, 400000);
  if (photo && !photo.startsWith("data:image/")) return res.status(400).json({ error: "foto_invalida" });
  const voiceId = String(b.voiceId || "").slice(0, 64);
  db.prepare(`
    INSERT INTO humans (user_id, name, bio, photo, voice_id, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET name=excluded.name, bio=excluded.bio, photo=excluded.photo,
      voice_id=excluded.voice_id, updated_at=datetime('now')
  `).run(user.id, name, bio, photo, voiceId);
  res.json({ ok: true });
});

app.get("/api/human/messages", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = db.prepare(
    "SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 50"
  ).all(user.id).reverse();
  res.json({ messages: rows });
});

app.post("/api/human/chat", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!ANTHROPIC_KEY && !OPENAI_KEY) return res.status(503).json({ error: "chat_no_configurado" });
  if (!rateLimit("u" + user.id, "chat", 60)) return res.status(429).json({ error: "demasiadas_peticiones" });
  const text = String((req.body || {}).text || "").trim().slice(0, 600);
  if (!text) return res.status(400).json({ error: "texto_vacio" });

  const human = db.prepare("SELECT name, bio FROM humans WHERE user_id = ?").get(user.id) ||
    { name: "Mi Human AI", bio: "" };
  const persona = [
    "Eres " + human.name + ", un Human AI privado creado en la plataforma HAI por " + (user.name || "tu familia") + ".",
    "Hablas SIEMPRE en español (o catalán si te hablan en catalán), natural, cercano y BREVE (2-4 frases).",
    human.bio ? "Tu historia y personalidad:\n" + human.bio : "Aún no te han contado tu historia: invita con cariño a rellenarla en el apartado ⚙️ de esta página.",
  ].join("\n\n");

  const prior = db.prepare(
    "SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 10"
  ).all(user.id).reverse();

  try {
    const reply = await askLLM(persona + "\n\n" + GUARDRAILS, [...prior, { role: "user", content: text }]);
    const ins = db.prepare("INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)");
    ins.run(user.id, "user", text);
    ins.run(user.id, "assistant", reply);
    res.json({ reply });
  } catch (err) {
    console.error("private chat error:", err.message);
    res.status(502).json({ error: "error_ia" });
  }
});

app.post("/api/human/tts", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!XI_KEY) return res.status(503).json({ error: "voz_no_configurada" });
  if (!rateLimit("u" + user.id, "tts", 40)) return res.status(429).json({ error: "demasiadas_peticiones" });
  const text = String((req.body || {}).text || "").slice(0, 600);
  if (!text.trim()) return res.status(400).json({ error: "texto_vacio" });
  const human = db.prepare("SELECT voice_id FROM humans WHERE user_id = ?").get(user.id);
  const voiceId = (human && human.voice_id) || XI_VOICE;
  if (!voiceId) return res.status(503).json({ error: "voz_no_configurada" });
  try {
    const audio = await elevenlabsTts(text, voiceId);
    res.setHeader("content-type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error("private tts error:", err.message);
    res.status(502).json({ error: "error_voz", detail: err.message });
  }
});

// ── Intranet: cuestionario guardado y archivos de recuerdos ──
const multer = require("multer");
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(UPLOADS_DIR, String(req._uid));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const safe = file.originalname.replace(/[^\w.\-áéíóúñç ]/gi, "_").slice(0, 120);
      cb(null, Date.now() + "-" + crypto.randomBytes(4).toString("hex") + "-" + safe);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

app.get("/api/intake", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = db.prepare("SELECT data, submitted, updated_at FROM intake WHERE user_id = ?").get(user.id);
  res.json({
    data: row ? JSON.parse(row.data) : {},
    submitted: !!(row && row.submitted),
    updatedAt: row ? row.updated_at : null,
  });
});

app.put("/api/intake", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const body = req.body || {};
  const json = JSON.stringify(body.data && typeof body.data === "object" ? body.data : {});
  if (json.length > 200_000) return res.status(400).json({ error: "respuestas_demasiado_largas" });
  const submitted = body.submitted ? 1 : 0;
  db.prepare(`
    INSERT INTO intake (user_id, data, submitted, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,
      submitted=MAX(intake.submitted, excluded.submitted), updated_at=datetime('now')
  `).run(user.id, json, submitted);
  res.json({ ok: true });
});

function attachUid(req, res, next) {
  const user = requireUser(req, res);
  if (!user) return;
  req._uid = user.id;
  req._user = user;
  next();
}

app.post("/api/files", attachUid, (req, res) => {
  const used = db.prepare("SELECT COALESCE(SUM(size),0) s FROM files WHERE user_id = ?").get(req._uid).s;
  if (used >= USER_QUOTA_BYTES) return res.status(413).json({ error: "espacio_agotado" });
  upload.single("file")(req, res, (err) => {
    if (err || !req.file) {
      return res.status(400).json({ error: err && err.code === "LIMIT_FILE_SIZE" ? "archivo_demasiado_grande" : "subida_fallida" });
    }
    const kind = ["fotos", "videos", "audios"].includes(req.body.kind) ? req.body.kind : "otros";
    const info = db.prepare(
      "INSERT INTO files (user_id, kind, name, mime, size, path) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(req._uid, kind, req.file.originalname.slice(0, 200), req.file.mimetype || "", req.file.size, req.file.path);
    res.json({ ok: true, file: { id: Number(info.lastInsertRowid), kind, name: req.file.originalname, size: req.file.size } });
  });
});

app.get("/api/files", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const rows = db.prepare("SELECT id, kind, name, size, created_at FROM files WHERE user_id = ? ORDER BY id").all(user.id);
  res.json({ files: rows, quota: USER_QUOTA_BYTES });
});

app.delete("/api/files/:id", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = db.prepare("SELECT * FROM files WHERE id = ? AND user_id = ?").get(Number(req.params.id), user.id);
  if (!row) return res.status(404).json({ error: "no_encontrado" });
  try { fs.unlinkSync(row.path); } catch (e) {}
  db.prepare("DELETE FROM files WHERE id = ?").run(row.id);
  res.json({ ok: true });
});

app.get("/api/files/:id", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const row = db.prepare("SELECT * FROM files WHERE id = ?").get(Number(req.params.id));
  if (!row || (row.user_id !== user.id && !isAdmin(user))) return res.status(404).json({ error: "no_encontrado" });
  res.setHeader("content-disposition", 'attachment; filename="' + row.name.replace(/"/g, "") + '"');
  res.setHeader("content-type", row.mime || "application/octet-stream");
  fs.createReadStream(row.path).on("error", () => res.status(410).end()).pipe(res);
});

// ── Solicitudes de experiencias (formularios por sector, sin cuenta) ──
const LEAD_SECTORS = ["business", "events", "museum", "tourism", "education", "homelive"];
app.post("/api/leads", (req, res) => {
  if (!rateLimit(clientIp(req), "leads", 10)) return res.status(429).json({ error: "demasiadas_peticiones" });
  const b = req.body || {};
  if (!LEAD_SECTORS.includes(b.sector)) return res.status(400).json({ error: "sector_invalido" });
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "email_invalido" });
  const json = JSON.stringify(b.data && typeof b.data === "object" ? b.data : {});
  if (json.length > 30_000) return res.status(400).json({ error: "respuestas_demasiado_largas" });
  db.prepare("INSERT INTO leads (sector, name, email, data) VALUES (?, ?, ?, ?)").run(
    b.sector, String(b.name || "").slice(0, 120), email, json
  );
  res.json({ ok: true });
});

app.get("/api/admin/leads", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!isAdmin(user)) return res.status(403).json({ error: "solo_administracion" });
  const rows = db.prepare("SELECT id, sector, name, email, data, created_at FROM leads ORDER BY id DESC LIMIT 200").all();
  res.json({ leads: rows.map((r) => ({ ...r, data: JSON.parse(r.data) })) });
});

// ── Panel de avatares (Fase 3): gestión de identidades del avatar en tiempo real ──
// Los assets viven en el volumen persistente (DATA_DIR/avatars/<slug>/), nunca en el repo.
// Flujo: crear ficha (con consentimiento) → subir material (identity.json + base.jpg
// + idle.webm de crear-identidad.html, y opcionalmente el vídeo de registro en bruto)
// → activar. Nada se procesa ni publica sin la confirmación explícita de activar.
const AVATARS_DIR = path.join(DATA_DIR, "avatars");
fs.mkdirSync(AVATARS_DIR, { recursive: true });

function audit(user, action, detail) {
  db.prepare("INSERT INTO audit_log (user_email, action, detail) VALUES (?, ?, ?)")
    .run(user.email, action, String(detail || "").slice(0, 500));
}
function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (!isAdmin(user)) { res.status(403).json({ error: "solo_administracion" }); return null; }
  return user;
}
function avatarBySlug(slug) {
  return db.prepare("SELECT * FROM avatars WHERE slug = ?").get(slug);
}
function avatarAssets(slug) {
  const dir = path.join(AVATARS_DIR, slug);
  const has = (f) => fs.existsSync(path.join(dir, f));
  return {
    identity: has("identity.json"),
    base: has("base.jpg") || has("base.png"),
    idle: has("idle.webm") || has("idle.mp4"),
    registro: fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.startsWith("registro.")),
  };
}

app.get("/api/avatars", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const rows = db.prepare("SELECT * FROM avatars ORDER BY id DESC").all();
  res.json({
    avatars: rows.map((r) => ({ ...r, consent: JSON.parse(r.consent), assets: avatarAssets(r.slug) })),
  });
});

app.post("/api/avatars", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const b = req.body || {};
  const slug = String(b.slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
  if (!slug || slug === "demo") return res.status(400).json({ error: "slug_invalido" });
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "nombre_vacio" });
  const consent = b.consent || {};
  // Consentimiento explícito obligatorio ANTES de crear nada (RGPD + política HAI)
  if (!consent.autorizacion || !consent.recreacion || !String(consent.firma || "").trim()) {
    return res.status(400).json({ error: "consentimiento_incompleto" });
  }
  const consentJson = JSON.stringify({
    autorizacion: true,
    recreacion: true,
    firma: String(consent.firma).slice(0, 120),
    relacion: String(consent.relacion || "").slice(0, 200),
    fecha: new Date().toISOString(),
    registrado_por: user.email,
  });
  try {
    db.prepare(`INSERT INTO avatars (slug, name, language, personality, voice_id, agent_id, mode, consent, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      slug, name,
      ["es", "ca", "en"].includes(b.language) ? b.language : "es",
      String(b.personality || "").slice(0, 8000),
      String(b.voice_id || "").slice(0, 64),
      String(b.agent_id || "").slice(0, 64),
      b.mode === "hologram" ? "hologram" : "normal",
      consentJson, user.id
    );
  } catch (e) {
    return res.status(409).json({ error: "slug_ya_existe" });
  }
  fs.mkdirSync(path.join(AVATARS_DIR, slug), { recursive: true });
  audit(user, "avatar_crear", slug + " (" + name + ")");
  res.json({ ok: true, slug });
});

app.put("/api/avatars/:slug", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const av = avatarBySlug(req.params.slug);
  if (!av) return res.status(404).json({ error: "no_encontrado" });
  const b = req.body || {};
  const status = ["draft", "processing", "active", "disabled"].includes(b.status) ? b.status : av.status;
  if (status === "active") {
    const assets = avatarAssets(av.slug);
    if (!assets.identity || !assets.base) {
      return res.status(400).json({ error: "faltan_assets", detail: "Sube identity.json y base.jpg antes de activar." });
    }
  }
  db.prepare(`UPDATE avatars SET name=?, language=?, personality=?, voice_id=?, agent_id=?, mode=?, status=?,
    updated_at=datetime('now') WHERE id=?`).run(
    String(b.name || av.name).slice(0, 80),
    ["es", "ca", "en"].includes(b.language) ? b.language : av.language,
    b.personality !== undefined ? String(b.personality).slice(0, 8000) : av.personality,
    b.voice_id !== undefined ? String(b.voice_id).slice(0, 64) : av.voice_id,
    b.agent_id !== undefined ? String(b.agent_id).slice(0, 64) : av.agent_id,
    b.mode === "hologram" ? "hologram" : b.mode === "normal" ? "normal" : av.mode,
    status, av.id
  );
  audit(user, "avatar_editar", av.slug + " → " + status);
  res.json({ ok: true });
});

app.delete("/api/avatars/:slug", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const av = avatarBySlug(req.params.slug);
  if (!av) return res.status(404).json({ error: "no_encontrado" });
  // Borrado real y definitivo: ficha + todos los archivos (derecho de supresión)
  db.prepare("DELETE FROM avatars WHERE id = ?").run(av.id);
  fs.rmSync(path.join(AVATARS_DIR, av.slug), { recursive: true, force: true });
  audit(user, "avatar_eliminar", av.slug);
  res.json({ ok: true });
});

// Subida de material del avatar: kind = identity | base | idle | registro
const AVATAR_KINDS = {
  identity: { name: "identity.json", types: ["application/json"] },
  base: { name: "base.jpg", types: ["image/jpeg", "image/png"] },
  idle: { name: "idle.webm", types: ["video/webm", "video/mp4"] },
  registro: { name: "registro", types: ["video/webm", "video/mp4", "video/quicktime"] },
};
const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(AVATARS_DIR, req._avatarSlug);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const k = AVATAR_KINDS[req._assetKind];
      if (k.name !== "registro") return cb(null, k.name);
      const ext = (path.extname(file.originalname) || ".mp4").toLowerCase().slice(0, 6);
      cb(null, "registro" + ext);
    },
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
});

app.post("/api/avatars/:slug/assets", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const av = avatarBySlug(req.params.slug);
  if (!av) return res.status(404).json({ error: "no_encontrado" });
  const kind = String(req.query.kind || "");
  if (!AVATAR_KINDS[kind]) return res.status(400).json({ error: "tipo_invalido" });
  req._avatarSlug = av.slug;
  req._assetKind = kind;
  avatarUpload.single("file")(req, res, (err) => {
    if (err || !req.file) {
      return res.status(400).json({ error: err && err.code === "LIMIT_FILE_SIZE" ? "archivo_demasiado_grande" : "subida_fallida" });
    }
    // base.png en vez de jpg: renombrar el fijo si hace falta
    if (kind === "base" && req.file.mimetype === "image/png") {
      fs.renameSync(req.file.path, path.join(path.dirname(req.file.path), "base.png"));
    }
    // Si solo hay vídeo de registro, el avatar queda "processing" (pendiente de extraer identidad)
    const assets = avatarAssets(av.slug);
    if (av.status === "draft" && assets.registro && !assets.identity) {
      db.prepare("UPDATE avatars SET status='processing', updated_at=datetime('now') WHERE id=?").run(av.id);
    }
    audit(user, "avatar_subida", av.slug + " · " + kind + " · " + req.file.originalname.slice(0, 80));
    res.json({ ok: true, assets: avatarAssets(av.slug) });
  });
});

// Servir la identidad y sus assets: públicos solo si el avatar está activo;
// en cualquier otro estado, solo administración (previsualización).
const IDENTITY_FILES = ["identity.json", "base.jpg", "base.png", "idle.webm", "idle.mp4"];
app.get("/api/identities/:slug/:file", (req, res) => {
  const slug = String(req.params.slug).toLowerCase().replace(/[^a-z0-9-]/g, "");
  const file = req.params.file;
  if (!IDENTITY_FILES.includes(file)) return res.status(404).json({ error: "no_encontrado" });
  const av = avatarBySlug(slug);
  if (!av) return res.status(404).json({ error: "no_encontrado" });
  if (av.status !== "active") {
    const u = currentUser(req);
    if (!u || !isAdmin(u)) return res.status(404).json({ error: "no_encontrado" });
  }
  const p = path.join(AVATARS_DIR, slug, file);
  if (!fs.existsSync(p)) return res.status(404).json({ error: "no_encontrado" });
  res.setHeader("cache-control", "private, max-age=300");
  res.sendFile(p);
});

app.get("/api/admin/audit", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  res.json({ audit: db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200").all() });
});

// ── Métricas de sesiones del avatar (Fase 5): anónimas, sin datos personales ──
app.post("/api/metrics", (req, res) => {
  if (!rateLimit(clientIp(req), "metrics", 60)) return res.status(429).json({ error: "demasiadas_peticiones" });
  const json = JSON.stringify(req.body && typeof req.body === "object" ? req.body : {});
  if (json.length > 2000) return res.status(400).json({ error: "demasiado_grande" });
  db.prepare("INSERT INTO metrics (data) VALUES (?)").run(json);
  res.json({ ok: true });
});

app.get("/api/admin/metrics", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const rows = db.prepare("SELECT id, data, created_at FROM metrics ORDER BY id DESC LIMIT 200").all()
    .map((r) => ({ id: r.id, created_at: r.created_at, ...JSON.parse(r.data) }));
  const nums = (k) => rows.map((r) => r[k]).filter((v) => typeof v === "number");
  const avg = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : null);
  res.json({
    sessions: rows,
    resumen: {
      total: rows.length,
      msToConnected_media: avg(nums("msToConnected")),
      msToFirstAudio_media: avg(nums("msToFirstAudio")),
      duracion_media_ms: avg(nums("durationMs")),
      fps_media: avg(nums("avgFps")),
      interrupciones_total: nums("interruptions").reduce((s, v) => s + v, 0),
      minutos_conversacion_total: Math.round(nums("durationMs").reduce((s, v) => s + v, 0) / 60000),
    },
  });
});

// ── Panel de administración (solo Montse) ──
app.get("/api/admin/clients", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!isAdmin(user)) return res.status(403).json({ error: "solo_administracion" });
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.created_at,
      h.name AS human_name,
      i.submitted, i.updated_at AS intake_updated,
      (SELECT COUNT(*) FROM files f WHERE f.user_id = u.id) AS files_count,
      (SELECT COALESCE(SUM(size),0) FROM files f WHERE f.user_id = u.id) AS files_bytes
    FROM users u
    LEFT JOIN humans h ON h.user_id = u.id
    LEFT JOIN intake i ON i.user_id = u.id
    ORDER BY u.id DESC
  `).all();
  res.json({ clients: rows });
});

app.get("/api/admin/clients/:id", (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!isAdmin(user)) return res.status(403).json({ error: "solo_administracion" });
  const uid = Number(req.params.id);
  const client = db.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").get(uid);
  if (!client) return res.status(404).json({ error: "no_encontrado" });
  const intake = db.prepare("SELECT data, submitted, updated_at FROM intake WHERE user_id = ?").get(uid);
  const human = db.prepare("SELECT name, bio, voice_id FROM humans WHERE user_id = ?").get(uid);
  const files = db.prepare("SELECT id, kind, name, size, created_at FROM files WHERE user_id = ? ORDER BY kind, id").all(uid);
  res.json({
    client, human: human || null, files,
    intake: intake ? { data: JSON.parse(intake.data), submitted: !!intake.submitted, updatedAt: intake.updated_at } : null,
  });
});

// Borrado definitivo de un cliente (derecho de supresión): cuenta, sesiones,
// Human AI, chats, cuestionario y todos sus archivos del disco.
app.delete("/api/admin/clients/:id", (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  const uid = Number(req.params.id);
  const target = db.prepare("SELECT id, email FROM users WHERE id = ?").get(uid);
  if (!target) return res.status(404).json({ error: "no_encontrado" });
  if (ADMIN_EMAILS.includes(target.email.toLowerCase())) {
    return res.status(400).json({ error: "no_se_puede_borrar_administracion" });
  }
  for (const f of db.prepare("SELECT path FROM files WHERE user_id = ?").all(uid)) {
    try { fs.unlinkSync(f.path); } catch (e) {}
  }
  try { fs.rmSync(path.join(UPLOADS_DIR, String(uid)), { recursive: true, force: true }); } catch (e) {}
  for (const t of ["files", "intake", "messages", "humans", "sessions"]) {
    db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(uid);
  audit(user, "cliente_eliminar", target.email);
  res.json({ ok: true });
});

// ── Chat público de la landing (María) ──
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

  try {
    const reply = await askLLM(persona + "\n\n" + GUARDRAILS, messages);
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
    const audio = await elevenlabsTts(text, XI_VOICE);
    res.setHeader("content-type", "audio/mpeg");
    res.send(audio);
  } catch (err) {
    console.error("tts error:", err.message);
    res.status(502).json({ error: "error_voz", detail: err.message });
  }
});

// ── HeyGen / LiveAvatar: avatar en directo (modo FULL, vía embed oficial) ──
const HEYGEN_KEY = process.env.HEYGEN_API_KEY || "";
const HEYGEN_AVATAR_ID = process.env.HEYGEN_AVATAR_ID || "";
const HEYGEN_VOICE_ID = process.env.HEYGEN_VOICE_ID || "";
const HEYGEN_CONTEXT_ID = process.env.HEYGEN_CONTEXT_ID || "";
const HEYGEN_SANDBOX = process.env.HEYGEN_SANDBOX !== "false";
let embedCache = null;
let embedCacheAt = 0;
const EMBED_TTL = 3600_000;

const WEB_PERSONA = `Eres HAI, la asistente oficial de la web de HAI — Human AI Experiences (hai.lagrafica.ai), un proyecto de La Gràfica Creative (Lleida). Tú misma eres una demostración viva del producto: un ser digital con rostro, voz y personalidad que escucha y responde en tiempo real. Hablas SIEMPRE en español (o en catalán si te hablan en catalán; otros idiomas si te los hablan), con tono cercano, profesional y entusiasta sin ser pesada. Respuestas BREVES (2-4 frases), porque se dicen en voz alta. Tu misión: explicar qué hace HAI, ayudar al visitante a imaginar su caso y animarle a pedir una demo o escribir.

QUÉ ES HAI: creamos seres digitales ("Human AI") con rostro real o creado digitalmente, voz personalizada o clonada, personalidad definida y conocimientos propios (catálogos, documentos, historia). Escuchan, entienden y responden en tiempo real, hablan varios idiomas y se adaptan a cada usuario. No somos un chatbot: un chatbot da respuestas escritas; nosotros creamos una experiencia con cara, voz y presencia. Lema: "La inteligencia artificial cobra vida".

LAS EXPERIENCIAS (cada una tiene su página en la web):
- HAI Business: recepcionistas y asistentes digitales para empresas, 24/7. Reciben visitas, responden sobre los servicios, derivan al equipo.
- HAI Events: presentadores holográficos para eventos y ferias. Presentan la agenda, dinamizan stands, atraen público.
- HAI Museum: personajes históricos que reciben y guían a los visitantes, contando la historia en primera persona.
- HAI Tourism: guías digitales multilingües para hoteles y destinos. Conserje 24 h, recomendaciones locales.
- HAI Education: tutores con rostro humano y paciencia infinita, entrenados con el temario del centro.
- HAI Home Live: presencia holográfica en casa con DOS MODOS y un botón para cambiar entre ellos — Modo IA (un avatar digital que acompaña y conversa 24/7, ideal para personas mayores o compañía) y Modo humano (una persona real se conecta por videollamada desde cualquier lugar y aparece en el holograma de casa, como si estuviera allí: la familia que vive lejos, el médico, una celebración a distancia).
- HAI Memories: "Los recuerdos no desaparecen. Se transforman." Recreaciones digitales de seres queridos para familias, funerarias y aseguradoras: su voz clonada, su historia y su forma de ser, para volver a hablar con ellos. Siempre con consentimiento verificado de la familia y con transparencia (la recreación nunca finge ser la persona real). Planes de Memories: Presencia Web+App 635 €/año; Presencia con Holograma interactivo 1.600 €/año; Memorial Web+App 1.400 €/año; Memorial con Holograma 3.000 €/año. El chat es siempre ilimitado.

FORMATOS donde puede vivir un HAI (la inteligencia está en la nube; el dispositivo es la ventana): página web, aplicación móvil, videollamada, ventilador holográfico, cabina holográfica a tamaño real, pantallas transparentes, quioscos táctiles, robots humanoides y visores como Apple Vision Pro o Meta Quest.

CÓMO FUNCIONA (4 pasos): 1) definimos su identidad (quién es, cómo habla, su cara); 2) le damos conocimientos propios del cliente; 3) creamos rostro y voz (voz clonada o diseñada, con consentimiento); 4) lo publicamos donde el cliente quiera y lo acompañamos.

SI TE PREGUNTAN "¿PUEDES TENER MI IMAGEN?": sí — podemos crear un Human AI con la imagen y la voz de una persona real (un fundador, una presentadora, un familiar), siempre con su consentimiento verificado. También podemos diseñar un personaje digital desde cero.

LA WEB Y CÓMO USARLA: en hai.lagrafica.ai el visitante puede: hablar contigo en la portada; ver cada experiencia con su página propia; probar la app del Human AI (demo móvil); hablar con María, la demo de Memories; y en Memories, crear su cuenta privada, rellenar el cuestionario de recuerdos (se guarda automáticamente) y subir fotos, vídeos y audios de su ser querido para que creemos su Human AI.

QUIÉN HAY DETRÁS — EL ECOSISTEMA LA GRÀFICA (si preguntan por la empresa u otros servicios):
- laGràfica (lagrafica.com): la agencia de publicidad y diseño gráfico de Lleida, con más de 20 años de trayectoria. Servicios: campañas de publicidad, branding e identidad corporativa, diseño gráfico y maquetación, diseño web (especialistas en WordPress y WooCommerce) y marketing online con gestión de redes sociales. "Idees que marquen". Contacto: info@lagrafica.com · 973 21 63 63 · C/ Manuel Gaya i Tomàs 11, Lleida.
- LaGràfica AI (lagrafica.ai): la agencia de inteligencia artificial. Tres pilares: PENSAMOS (estrategia, marca y dirección creativa asistida por IA), CREAMOS (diseño, motion graphics, imágenes, webs, apps y vídeos publicitarios con IA) y AUTOMATIZAMOS (automatizaciones, agentes de IA que atienden clientes en web o WhatsApp, aplicaciones propias y sistemas a medida). También hacen auditorías de IA para empresas y actúan como partner tecnológico de otras agencias de marketing ("más capacidad sin aumentar estructura").
- HAI (esta web) es la experiencia más avanzada de ese ecosistema: los seres digitales con rostro y voz.
Si el visitante necesita diseño, una web, una campaña o automatizar procesos, recomiéndale la web correspondiente (lagrafica.com o lagrafica.ai) con naturalidad.

CONTACTO Y SIGUIENTE PASO: para pedir demo o presupuesto de HAI, el botón de contacto de la web o lagraficacreative@gmail.com. Para la agencia: info@lagrafica.com o el 973 21 63 63.

LÍMITES: eres una asistente digital y lo dices con naturalidad si te lo preguntan. Los únicos precios públicos son los planes de Memories listados arriba; para el resto de experiencias (Business, Events, etc.) NO des cifras: cada proyecto se presupuesta a medida, invita a escribirnos. No inventes funcionalidades, clientes ni plazos. Nada de consejos médicos, legales o financieros. Si no sabes algo: dilo con naturalidad y ofrece recoger el contacto para que el equipo responda.`;

const WEB_OPENING = "¡Hola! Soy HAI. Puedo escucharte, entender tus preguntas y responderte en tiempo real. Pregúntame qué puedo hacer por tu empresa, por tus clientes o por las personas que visitan este espacio.";

async function laApi(pathName, opts = {}) {
  const res = await fetch("https://api.liveavatar.com" + pathName, {
    ...opts,
    headers: { "content-type": "application/json", "X-API-KEY": HEYGEN_KEY, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error("liveavatar " + pathName + " " + res.status + " " + (await res.text()).slice(0, 200));
  return (await res.json()).data;
}

async function pickPublicAvatar() {
  const pub = await laApi("/v1/avatars/public?page_size=50");
  const chosen = (pub.results || []).find((a) => a.status === "ACTIVE" && a.default_voice) || (pub.results || [])[0];
  if (!chosen) throw new Error("sin avatares disponibles");
  return chosen;
}

app.get("/api/avatar-embed", async (req, res) => {
  if (!HEYGEN_KEY) return res.status(503).json({ error: "avatar_no_configurado" });
  if (embedCache && Date.now() - embedCacheAt < EMBED_TTL) return res.json(embedCache);
  if (!rateLimit(clientIp(req), "embed", 10)) return res.status(429).json({ error: "demasiadas_peticiones" });
  try {
    // Avatar preferido: el configurado (el de Montse) solo si ya está activo; si no, catálogo público
    let avatarId = null;
    let voiceId = HEYGEN_VOICE_ID;
    if (HEYGEN_AVATAR_ID) {
      const mine = await laApi("/v1/avatars?page_size=50").catch(() => ({ results: [] }));
      const own = (mine.results || []).find((a) => a.id === HEYGEN_AVATAR_ID);
      if (own && own.status === "ACTIVE") {
        avatarId = own.id;
        if (!voiceId && own.default_voice) voiceId = own.default_voice.id;
      }
    }
    if (!avatarId) {
      const avatars = await laApi("/v1/avatars?page_size=50").catch(() => ({ results: [] }));
      const own = (avatars.results || []).find((a) => a.status === "ACTIVE");
      if (own) {
        avatarId = own.id;
        if (!voiceId && own.default_voice) voiceId = own.default_voice.id;
      }
    }
    if (!avatarId) {
      const pub = await pickPublicAvatar();
      avatarId = pub.id;
      if (!voiceId && pub.default_voice) voiceId = pub.default_voice.id;
    }
    if (!voiceId) {
      const voices = await laApi("/v1/voices?voice_type=private&page_size=50").catch(() => ({ results: [] }));
      voiceId = ((voices.results || [])[0] || {}).id;
    }
    if (!voiceId) {
      const pub = await pickPublicAvatar();
      voiceId = (pub.default_voice || {}).id;
    }
    let contextId = HEYGEN_CONTEXT_ID;
    if (!contextId) {
      const contexts = await laApi("/v1/contexts?page_size=50").catch(() => ({ results: [] }));
      const existing = (contexts.results || []).find((c) => c.name === "HAI asistente web v4");
      contextId = existing
        ? existing.id
        : (await laApi("/v1/contexts", {
            method: "POST",
            body: JSON.stringify({ name: "HAI asistente web v4", prompt: WEB_PERSONA, opening_text: WEB_OPENING }),
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
        max_session_duration: 300,
      }),
    });
    embedCache = { url: embed.url, sandbox: HEYGEN_SANDBOX, avatarId };
    embedCacheAt = Date.now();
    res.json(embedCache);
  } catch (err) {
    console.error("avatar-embed error:", err.message);
    res.status(502).json({ error: "error_avatar", detail: err.message.slice(0, 300) });
  }
});

// ── ElevenLabs Agents: avatar conversacional propio (módulo avatar-live) ──
// El navegador NUNCA ve la API key: pide aquí un token efímero de sesión.
// El agente se localiza por env ELEVENLABS_AGENT_ID o se crea una vez por nombre
// (mismo patrón que los contexts de LiveAvatar). La clave necesita los permisos
// de Agents (ConvAI) además de text_to_speech.
const XI_AGENT_ID = process.env.ELEVENLABS_AGENT_ID || "";
const XI_AGENT_NAME = "HAI asistente web (avatar-live) v1";
let xiAgentCache = XI_AGENT_ID || null;
// Eventos que el agente debe emitir al navegador. "alignment" (timing por
// carácter) alimenta los visemas del lip sync avanzado.
const XI_CLIENT_EVENTS = ["audio", "interruption", "user_transcript", "agent_response", "agent_response_correction", "alignment"];
const xiPatchedAgents = new Set();
// Asegura que un agente ya existente tenga los client_events necesarios
// (los creados antes de los visemas, o creados a mano en el panel de ElevenLabs).
async function ensureXiClientEvents(agentId) {
  if (xiPatchedAgents.has(agentId)) return;
  try {
    await xiApi("/v1/convai/agents/" + agentId, {
      method: "PATCH",
      body: JSON.stringify({ conversation_config: { conversation: { client_events: XI_CLIENT_EVENTS } } }),
    });
    xiPatchedAgents.add(agentId);
  } catch (err) {
    // No bloquea la conversación: sin alignment el lip sync cae a energía
    console.warn("No se han podido actualizar los client_events de", agentId + ":", err.message.slice(0, 160));
  }
}

async function xiApi(pathName, opts = {}) {
  const res = await fetch("https://api.elevenlabs.io" + pathName, {
    ...opts,
    headers: { "content-type": "application/json", "xi-api-key": XI_KEY, ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error("elevenlabs " + pathName + " " + res.status + " " + (await res.text()).slice(0, 200));
  return res.json();
}

async function ensureXiAgent() {
  if (xiAgentCache) return xiAgentCache;
  const list = await xiApi("/v1/convai/agents?page_size=100").catch(() => null);
  const existing = list && (list.agents || []).find((a) => a.name === XI_AGENT_NAME);
  if (existing) {
    xiAgentCache = existing.agent_id;
    return xiAgentCache;
  }
  const created = await xiApi("/v1/convai/agents/create", {
    method: "POST",
    body: JSON.stringify({
      name: XI_AGENT_NAME,
      conversation_config: {
        agent: {
          first_message: WEB_OPENING,
          language: "es",
          prompt: { prompt: WEB_PERSONA + "\n\n" + GUARDRAILS },
        },
        // Los agentes no ingleses exigen turbo o flash v2_5 (el default
        // eleven_flash_v2 es solo inglés y ElevenLabs devuelve 400).
        tts: { model_id: "eleven_flash_v2_5", ...(XI_VOICE ? { voice_id: XI_VOICE } : {}) },
        conversation: { client_events: XI_CLIENT_EVENTS },
      },
    }),
  });
  xiAgentCache = created.agent_id;
  console.log("Agente de ElevenLabs creado:", xiAgentCache, "→ fija ELEVENLABS_AGENT_ID=" + xiAgentCache + " en Coolify");
  return xiAgentCache;
}

// Agente propio por avatar: si la ficha no tiene agent_id asignado, se crea uno
// a partir de su personalidad, idioma y voz, y se guarda en la ficha.
async function ensureAvatarAgent(av) {
  if (av.agent_id) return av.agent_id;
  const created = await xiApi("/v1/convai/agents/create", {
    method: "POST",
    body: JSON.stringify({
      name: "HAI avatar · " + av.slug,
      conversation_config: {
        agent: {
          language: av.language || "es",
          prompt: { prompt: (av.personality || ("Eres " + av.name + ", un Human AI creado con la plataforma HAI.")) + "\n\n" + GUARDRAILS },
        },
        tts: { model_id: "eleven_flash_v2_5", ...((av.voice_id || XI_VOICE) ? { voice_id: av.voice_id || XI_VOICE } : {}) },
        conversation: { client_events: XI_CLIENT_EVENTS },
      },
    }),
  });
  db.prepare("UPDATE avatars SET agent_id=?, updated_at=datetime('now') WHERE id=?").run(created.agent_id, av.id);
  console.log("Agente de ElevenLabs creado para avatar", av.slug + ":", created.agent_id);
  return created.agent_id;
}

app.get("/api/agents/token", async (req, res) => {
  if (!XI_KEY) return res.status(503).json({ error: "avatar_no_configurado" });
  if (!rateLimit(clientIp(req), "agent-token", 30)) return res.status(429).json({ error: "demasiadas_peticiones" });
  try {
    let agentId;
    const slug = String(req.query.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (slug && slug !== "demo") {
      const av = avatarBySlug(slug);
      const u = av && av.status !== "active" ? currentUser(req) : null;
      if (!av || (av.status !== "active" && !(u && isAdmin(u)))) {
        return res.status(404).json({ error: "avatar_no_disponible" });
      }
      agentId = await ensureAvatarAgent(av);
    } else {
      agentId = await ensureXiAgent();
    }
    await ensureXiClientEvents(agentId);
    try {
      // WebRTC (preferido: menos latencia y gestión de audio más robusta)
      const t = await xiApi("/v1/convai/conversation/token?agent_id=" + agentId);
      return res.json({ token: t.token, agentId });
    } catch (e) {
      // Respaldo: WebSocket con URL firmada
      const s = await xiApi("/v1/convai/conversation/get-signed-url?agent_id=" + agentId);
      return res.json({ signedUrl: s.signed_url, agentId });
    }
  } catch (err) {
    console.error("agents token error:", err.message);
    res.status(502).json({ error: "error_avatar", detail: err.message.slice(0, 300) });
  }
});

// Rutas limpias del módulo avatar-live (avatar.html de LiveAvatar sigue intacto)
app.get("/avatar", (_req, res) => res.sendFile(path.join(__dirname, "public", "avatar-live", "avatar.html")));
app.get("/hologram", (_req, res) => res.sendFile(path.join(__dirname, "public", "avatar-live", "hologram.html")));

app.get("/api/health", (_req, res) => {
  res.json({
    chat: !!(ANTHROPIC_KEY || OPENAI_KEY),
    tts: !!(XI_KEY && XI_VOICE),
    avatar: !!HEYGEN_KEY,
    avatarLive: !!XI_KEY,
    accounts: true,
  });
});

const PORT = process.env.PORT || 80;
app.listen(PORT, () => console.log("HAI web + cerebro escuchando en :" + PORT));
