// ConversationProvider — contrato del informe Fase 0.
// Implementación real: ElevenLabsAgentsProvider (SDK oficial @elevenlabs/client,
// empaquetado en vendor/ — la API key vive SOLO en el servidor, aquí llega un
// token efímero de /api/agents/token).
// Implementación de pruebas: DemoProvider (sin micro ni red) para ?demo=1.
//
// Eventos que emite cualquier provider:
//   state: connecting | listening | thinking | speaking | interrupted | error | ended
//   error: mensaje legible
//   transcript: { source: "user"|"agent", text }  (informativo)

import { Conversation } from "./vendor/elevenlabs-client.js";

class Emitter {
  constructor() { this.h = {}; }
  on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
  emit(ev, data) { (this.h[ev] || []).forEach((fn) => fn(data)); }
}

export class ElevenLabsAgentsProvider extends Emitter {
  constructor(avatarId) {
    super();
    this.avatarId = avatarId || "";
    this.conversation = null;
    this.lastMode = "listening";
  }

  async connect() {
    this.emit("state", "connecting");

    // Pedir permiso de micro antes de nada: errores más claros para el usuario
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } });
      s.getTracks().forEach((t) => t.stop());
    } catch (e) {
      this.emit("error", "Necesito permiso para usar el micrófono. Revisa el candado de la barra del navegador.");
      this.emit("state", "error");
      throw e;
    }

    let auth;
    try {
      const r = await fetch("/api/agents/token" + (this.avatarId ? "?id=" + encodeURIComponent(this.avatarId) : ""));
      if (!r.ok) {
        const code = (await r.json().catch(() => ({}))).error || r.status;
        const msg = r.status === 503
          ? "El avatar en tiempo real aún no está activado en el servidor."
          : r.status === 429
            ? "Demasiadas conexiones seguidas. Espera un momento y vuelve a intentarlo."
            : "No se ha podido preparar la conversación (" + code + ").";
        this.emit("error", msg);
        this.emit("state", "error");
        throw new Error("token " + r.status);
      }
      auth = await r.json();
    } catch (e) {
      if (!this.h.error) throw e;
      if (!String(e.message).startsWith("token")) {
        this.emit("error", "Sin conexión con el servidor. Revisa tu red y recarga.");
        this.emit("state", "error");
      }
      throw e;
    }

    const session = auth.token
      ? { conversationToken: auth.token, connectionType: "webrtc" }
      : { signedUrl: auth.signedUrl, connectionType: "websocket" };

    this.conversation = await Conversation.startSession({
      ...session,
      onConnect: () => this.emit("state", "listening"),
      onDisconnect: () => this.emit("state", "ended"),
      onError: (message) => {
        console.error("agents error:", message);
        this.emit("error", "La conversación se ha cortado. Puedes volver a conectar.");
        this.emit("state", "error");
      },
      onModeChange: ({ mode }) => {
        // El SDK gestiona VAD, turnos e interrupciones; aquí solo traducimos.
        if (mode === "speaking") {
          this.emit("state", "speaking");
        } else {
          // Si el agente estaba hablando y pasa a escuchar con audio a medias → interrupción
          if (this.lastMode === "speaking" && this.getOutputVolume() > 0.05) {
            this.emit("state", "interrupted");
            setTimeout(() => this.lastMode !== "speaking" && this.emit("state", "listening"), 650);
          } else {
            this.emit("state", "listening");
          }
        }
        this.lastMode = mode;
      },
      onMessage: (m) => {
        if (!m) return;
        if (m.source === "user") {
          this.emit("transcript", { source: "user", text: m.message || "" });
          this.emit("state", "thinking"); // ha terminado de hablar el usuario: pensando
        } else if (m.source === "ai") {
          this.emit("transcript", { source: "agent", text: m.message || "" });
        }
      },
    });
  }

  getOutputVolume() {
    try { return this.conversation ? this.conversation.getOutputVolume() : 0; }
    catch (e) { return 0; }
  }

  getOutputByteFrequencyData() {
    try { return this.conversation ? this.conversation.getOutputByteFrequencyData() : null; }
    catch (e) { return null; }
  }

  async disconnect() {
    const c = this.conversation;
    this.conversation = null;
    if (c) { try { await c.endSession(); } catch (e) {} }
    this.emit("state", "ended");
  }
}

// ── DemoProvider: ciclo guionizado para probar renderer y estados sin claves ──
export class DemoProvider extends Emitter {
  constructor() {
    super();
    this.timer = 0;
    this.speaking = false;
    this.t0 = 0;
    this.stopped = false;
  }

  async connect() {
    this.stopped = false;
    this.emit("state", "connecting");
    const cycle = async () => {
      if (this.stopped) return;
      this.emit("state", "listening");
      await this._wait(2600); if (this.stopped) return;
      this.emit("transcript", { source: "user", text: "(demo) ¿Qué es HAI?" });
      this.emit("state", "thinking");
      await this._wait(1100); if (this.stopped) return;
      this.speaking = true; this.t0 = performance.now();
      this.emit("state", "speaking");
      await this._wait(4800); if (this.stopped) return;
      this.speaking = false;
      this.emit("state", "interrupted");
      await this._wait(650); if (this.stopped) return;
      cycle();
    };
    await this._wait(900);
    cycle();
  }

  _wait(ms) { return new Promise((r) => (this.timer = setTimeout(r, ms))); }

  // Voz sintética: sílabas ~4/s con pausas de "palabra"
  getOutputVolume() {
    if (!this.speaking) return 0;
    const t = (performance.now() - this.t0) / 1000;
    const word = Math.sin(t * 0.9) > -0.6 ? 1 : 0; // pausas entre frases
    const syl = Math.max(0, Math.sin(t * Math.PI * 4.2)) * (0.55 + 0.45 * Math.sin(t * 1.3));
    return word * syl * 0.5;
  }

  getOutputByteFrequencyData() { return null; }

  async disconnect() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.emit("state", "ended");
  }
}
