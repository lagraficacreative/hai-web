// SimliHaiWidget — cara neuronal (Simli) + cerebro/voz (ElevenLabs Agents).
// Se abre en overlay al pulsar cualquier <button data-hai-avatar="business|events|...">.
// Cómo se enchufan los dos:
//   ElevenLabs SDK reproduce el audio del agente en un <audio> que crea él.
//   Le ponemos setVolume(0) para que no suene por ambos sitios y le pasamos
//   ese <audio> a simliClient.listenToAudioElement() → Simli hace lipsync
//   sobre el vídeo del avatar y lo reproduce con su propio <audio>.
// Ventaja: mantenemos toda la gestión del SDK (turnos, VAD, interrupciones)
// y evitamos WebSockets manuales.

import { SimliClient, generateIceServers, LogLevel } from "./vendor/simli-client.js";
import { Conversation } from "./vendor/elevenlabs-client.js";

const OVERLAY_ID = "hai-simli-overlay";

const STATE_LABEL = {
  idle: "Preparado", connecting: "Conectando…", listening: "Te escucho",
  thinking: "Pensando…", speaking: "Hablando", interrupted: "Te escucho…",
  ended: "Conversación finalizada", error: "Error",
};

function css() {
  return `
    #${OVERLAY_ID}{position:fixed;inset:0;background:rgba(5,10,20,.86);backdrop-filter:blur(14px);
      z-index:9999;display:none;align-items:center;justify-content:center;padding:20px}
    #${OVERLAY_ID}.visible{display:flex}
    #${OVERLAY_ID} .box{background:#0F3963;border:1px solid rgba(255,255,255,.08);border-radius:20px;
      max-width:min(560px,96vw);width:100%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5);
      font-family:"Manrope",system-ui,sans-serif;color:#F7FAFF}
    #${OVERLAY_ID} .stage{position:relative;aspect-ratio:3/4;background:#000;overflow:hidden}
    #${OVERLAY_ID} .stage video{width:100%;height:100%;object-fit:cover;display:block;background:#000}
    #${OVERLAY_ID} .placeholder{position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:14px;color:#A7BCD9;font-size:14px;text-align:center;padding:20px}
    #${OVERLAY_ID} .orb{width:80px;height:80px;border-radius:50%;
      background:radial-gradient(circle at 35% 35%,#A78BFA,#7C6AF7 55%,#22D3EE);animation:hai-pulse 2.4s ease-in-out infinite}
    @keyframes hai-pulse{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.07);opacity:1}}
    #${OVERLAY_ID} .status{position:absolute;top:12px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.1);border-radius:999px;
      padding:6px 14px;font-size:12.5px;display:flex;align-items:center;gap:8px;backdrop-filter:blur(6px)}
    #${OVERLAY_ID} .dot{width:8px;height:8px;border-radius:50%;background:#9A9AB0;transition:background .25s}
    #${OVERLAY_ID} .status[data-s="listening"] .dot{background:#34D399;animation:hai-blink 1.6s infinite}
    #${OVERLAY_ID} .status[data-s="thinking"] .dot{background:#FBBF24;animation:hai-blink .9s infinite}
    #${OVERLAY_ID} .status[data-s="speaking"] .dot{background:#22D3EE}
    #${OVERLAY_ID} .status[data-s="connecting"] .dot{background:#A78BFA;animation:hai-blink .7s infinite}
    #${OVERLAY_ID} .status[data-s="error"] .dot{background:#F87171}
    @keyframes hai-blink{0%,100%{opacity:1}50%{opacity:.35}}
    #${OVERLAY_ID} .ia-mark{position:absolute;bottom:10px;right:12px;font-size:10.5px;
      letter-spacing:.08em;opacity:.55;text-transform:uppercase}
    #${OVERLAY_ID} .controls{padding:16px 18px 20px;display:flex;gap:10px;flex-wrap:wrap;justify-content:center}
    #${OVERLAY_ID} button{font-family:inherit;font-weight:600;font-size:14px;border-radius:12px;
      padding:11px 20px;border:0;cursor:pointer;transition:transform .1s}
    #${OVERLAY_ID} button:focus-visible{outline:3px solid #22D3EE;outline-offset:2px}
    #${OVERLAY_ID} button:active{transform:scale(.97)}
    #${OVERLAY_ID} .btn-close{background:rgba(248,113,113,.15);color:#F87171;border:1px solid rgba(248,113,113,.35)}
    #${OVERLAY_ID} .btn-close:hover{background:rgba(248,113,113,.22)}
    #${OVERLAY_ID} .err{padding:0 18px 14px;color:#F87171;font-size:13px;text-align:center}
    #${OVERLAY_ID} .note{padding:0 18px 14px;color:#A7BCD9;font-size:11.5px;text-align:center}
  `;
}

function ensureStyles() {
  if (document.getElementById("hai-simli-styles")) return;
  const s = document.createElement("style");
  s.id = "hai-simli-styles";
  s.textContent = css();
  document.head.appendChild(s);
}

function buildOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = OVERLAY_ID;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-label", "Habla en directo con HAI");
  el.innerHTML = `
    <div class="box">
      <div class="stage">
        <video autoplay playsinline></video>
        <audio autoplay style="display:none"></audio>
        <div class="placeholder"><div class="orb"></div><div>Preparando el avatar…</div></div>
        <div class="status" data-s="idle"><span class="dot"></span><span class="stxt">Preparado</span></div>
        <div class="ia-mark">IA</div>
      </div>
      <div class="err" style="display:none"></div>
      <div class="controls"><button class="btn-close">Finalizar</button></div>
      <div class="note">Estás hablando con un ser digital creado con inteligencia artificial.</div>
    </div>`;
  document.body.appendChild(el);
  return el;
}

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || ("HTTP " + r.status));
    return data;
  });
}
function get(url) {
  return fetch(url).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.detail || data.error || ("HTTP " + r.status));
    return data;
  });
}

class SimliHaiSession {
  constructor(overlay) {
    this.overlay = overlay;
    this.video = overlay.querySelector("video");
    this.audio = overlay.querySelector("audio");
    this.placeholder = overlay.querySelector(".placeholder");
    this.status = overlay.querySelector(".status");
    this.stxt = overlay.querySelector(".stxt");
    this.errEl = overlay.querySelector(".err");
    this.closeBtn = overlay.querySelector(".btn-close");
    this.simli = null;
    this.conversation = null;
    this.mo = null; // MutationObserver para pillar el <audio> que crea el SDK
    this.closeBtn.onclick = () => this.stop();
  }

  setState(s) {
    this.status.dataset.s = s;
    this.stxt.textContent = STATE_LABEL[s] || s;
  }
  showError(msg) {
    this.errEl.textContent = msg;
    this.errEl.style.display = "block";
    this.setState("error");
  }
  hidePlaceholder() {
    this.placeholder.style.display = "none";
  }

  async start(experience) {
    this.errEl.style.display = "none";
    this.setState("connecting");

    // 1) Permiso de micro con mensaje claro si lo deniegan
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      this.showError("Necesito permiso para usar el micrófono. Revisa el candado de la barra del navegador.");
      throw e;
    }

    // 2) Sesión de Simli (cara + WebRTC), y contra ElevenLabs Agents (cerebro + voz) en paralelo
    let simliTok, xiAuth;
    try {
      [simliTok, xiAuth] = await Promise.all([
        post("/api/simli/token", {}),
        get("/api/agents/token?exp=" + encodeURIComponent(experience)),
      ]);
    } catch (e) {
      const m = /simli_no_configurado/.test(e.message)
        ? "El avatar en directo aún no está activado en el servidor."
        : /avatar_no_configurado/.test(e.message)
        ? "El cerebro de voz aún no está activado en el servidor."
        : "No se ha podido preparar la conversación (" + e.message + ").";
      this.showError(m);
      throw e;
    }

    // 3) Arrancar SimliClient (WebRTC → renderiza vídeo en <video>)
    const iceServers = await generateIceServers(null, undefined, simliTok.session_token).catch(() => []);
    this.simli = new SimliClient(
      simliTok.session_token, this.video, this.audio,
      iceServers, LogLevel.WARN, "livekit", "websockets"
    );
    this.simli.on("start", () => this.hidePlaceholder());
    this.simli.on("error", (e) => this.showError("Se ha cortado la cara del avatar. Cierra y vuelve a abrir."));
    await this.simli.start();

    // 4) Encaminar el audio del agente de ElevenLabs a Simli para el lipsync.
    //    El SDK crea un <audio> con srcObject = MediaStream (WebRTC/LiveKit).
    //    Preferimos listenToMediastreamTrack(track) — el <audio> puede quedar
    //    muted sin afectar al análisis, porque Simli usa el track directo.
    //    Como LiveKit puede tardar en asignar el srcObject, combinamos
    //    MutationObserver + poll durante 8 s.
    const self = this;
    self.hookedTrack = false;
    const tryHook = (a) => {
      if (self.hookedTrack || a === self.audio || a.dataset.haiHooked === "1") return false;
      const so = a.srcObject;
      const tracks = so && so.getAudioTracks && so.getAudioTracks();
      if (!tracks || !tracks.length) return false; // aún no ha llegado el track
      a.dataset.haiHooked = "1";
      a.volume = 0; a.muted = true; // silenciamos SOLO la reproducción duplicada
      try {
        self.simli.listenToMediastreamTrack(tracks[0]);
        console.log("[HAI] Simli enganchado al MediaStreamTrack del agente");
        self.hookedTrack = true; return true;
      } catch (err) {
        console.warn("[HAI] listenToMediastreamTrack falló, fallback a listenToAudioElement:", err);
        try { self.simli.listenToAudioElement(a); self.hookedTrack = true; return true; }
        catch (e) { console.error("[HAI] Simli no ha podido escuchar el audio:", e); return false; }
      }
    };
    const scanAll = () => document.querySelectorAll("audio").forEach(tryHook);
    self.mo = new MutationObserver(scanAll);
    self.mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcobject"] });
    scanAll(); // por si el <audio> ya estaba antes de que empezáramos
    let polls = 0;
    self.pollHook = setInterval(() => {
      polls++;
      scanAll();
      if (self.hookedTrack || polls > 30) { clearInterval(self.pollHook); self.pollHook = null; }
    }, 300);

    // 5) ElevenLabs Agents. Preferimos WebRTC; si el token no llegó, WS firmado.
    const startOpts = xiAuth.token
      ? { conversationToken: xiAuth.token, connectionType: "webrtc" }
      : { signedUrl: xiAuth.signedUrl, connectionType: "websocket" };
    this.conversation = await Conversation.startSession({
      ...startOpts,
      onConnect: () => {
        this.setState("listening");
        try { this.conversation.setVolume({ volume: 0 }); } catch (e) {}
      },
      onDisconnect: () => this.setState("ended"),
      onError: (msg) => this.showError("La conversación se ha cortado (" + String(msg).slice(0, 120) + ")."),
      onModeChange: ({ mode }) => this.setState(mode === "speaking" ? "speaking" : "listening"),
      onMessage: (m) => {
        if (m && m.source === "user") this.setState("thinking");
      },
    });
  }

  async stop() {
    try { this.mo && this.mo.disconnect(); } catch (e) {}
    this.mo = null;
    if (this.pollHook) { clearInterval(this.pollHook); this.pollHook = null; }
    if (this.conversation) { try { await this.conversation.endSession(); } catch (e) {} this.conversation = null; }
    if (this.simli) { try { await this.simli.stop(); } catch (e) {} this.simli = null; }
    // Quitar rastros: <audio> hookeados que dejó el SDK
    document.querySelectorAll('audio[data-hai-hooked="1"]').forEach((a) => a.remove());
    this.setState("ended");
    this.overlay.classList.remove("visible");
    this.placeholder.style.display = "";
  }
}

let session = null;

function open(experience) {
  ensureStyles();
  const overlay = buildOverlay();
  overlay.classList.add("visible");
  if (session) session.stop();
  session = new SimliHaiSession(overlay);
  session.start(experience).catch((err) => console.warn("simli-widget start error:", err.message));
}

// API global mínima por si se llama a mano desde un script inline
window.HAI = window.HAI || {};
window.HAI.openAvatar = open;

// Delegación: cualquier botón con data-hai-avatar="<experiencia>" abre el widget
document.addEventListener("click", (ev) => {
  const btn = ev.target && ev.target.closest && ev.target.closest("[data-hai-avatar]");
  if (!btn) return;
  ev.preventDefault();
  open(btn.dataset.haiAvatar);
});

// Liberar recursos al cerrar la pestaña
window.addEventListener("pagehide", () => session && session.stop());
