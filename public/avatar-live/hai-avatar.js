// Orquestador del avatar en tiempo real: une ConversationProvider + LipSyncDriver
// + AvatarRenderer. Es la única pieza que conocen las páginas /avatar y /hologram.
// Cambiar de motor (p. ej. renderer neuronal WebRTC en Fase 4) = cambiar aquí una clase.

import { Hybrid2DRenderer } from "./renderer2d.js";
import { VisemeLipSync } from "./lipsync.js";
import { ElevenLabsAgentsProvider, DemoProvider } from "./providers.js";

export const STATES = ["idle", "connecting", "listening", "thinking", "speaking", "interrupted", "error", "ended"];

export const STATE_LABELS = {
  idle: "Preparado",
  connecting: "Conectando…",
  listening: "Te escucho",
  thinking: "Pensando…",
  speaking: "Hablando",
  interrupted: "Te escucho…",
  error: "Error",
  ended: "Conversación finalizada",
};

export class HaiAvatar {
  constructor({ canvas, identityUrl, avatarId = "", demo = false, onState = () => {}, onError = () => {}, onTranscript = () => {} }) {
    this.renderer = new Hybrid2DRenderer(canvas);
    this.identityUrl = identityUrl;
    this.avatarId = avatarId;
    this.demo = demo;
    this.provider = null;
    this.lipsync = null;
    this.onState = onState;
    this.onError = onError;
    this.onTranscript = onTranscript;
    this.state = "idle";
    this.animRaf = 0;
    this.lastT = 0;
  }

  async load() {
    await this.renderer.load(this.identityUrl);
    this.renderer.start();
    this._setState("idle");
    return this;
  }

  _setState(s) {
    this.state = s;
    this.renderer.setState(s === "ended" ? "idle" : s);
    this.onState(s, STATE_LABELS[s] || s);
  }

  async startConversation() {
    if (this.provider) return;
    this.provider = this.demo ? new DemoProvider() : new ElevenLabsAgentsProvider(this.avatarId);

    // Métricas de la sesión (Fase 5): latencias, fps, interrupciones
    this.metrics = {
      startedAt: Date.now(),
      tStart: performance.now(),
      msToConnected: null,
      msToFirstAudio: null,
      interruptions: 0,
      alignmentEvents: 0,
      frames: 0,
      demo: this.demo,
      avatarId: this.avatarId || "demo",
    };

    this.provider
      .on("state", (s) => {
        if (s === "listening" && this.metrics && this.metrics.msToConnected === null) {
          this.metrics.msToConnected = Math.round(performance.now() - this.metrics.tStart);
        }
        if (s === "interrupted" && this.metrics) this.metrics.interruptions++;
        // Corte inesperado (red, fin de sesión remoto): avisar para reconectar
        if (s === "ended" && !this._stopping && this.provider) {
          this.onError("La conversación se ha cortado. Pulsa «Hablar con HAI» para reconectar.");
          this.stopConversation(false);
          this._setState("ended");
          return;
        }
        this._setState(s);
      })
      .on("error", (msg) => this.onError(msg))
      .on("transcript", (t) => this.onTranscript(t))
      .on("alignment", (a) => {
        this.metrics.alignmentEvents++;
        if (this.lipsync) this.lipsync.addAlignment(a);
      });

    // Visemas cuando llega alignment; energía como base y red de seguridad
    this.lipsync = new VisemeLipSync(
      () => (this.provider ? this.provider.getOutputVolume() : 0),
      () => (this.provider ? this.provider.getOutputByteFrequencyData() : null)
    );

    // Bucle de lip sync independiente del render (mismo rAF cadence)
    this.lastT = performance.now();
    const loop = (now) => {
      if (!this.provider) return;
      const dt = Math.min(0.05, (now - this.lastT) / 1000);
      this.lastT = now;
      this.metrics.frames++;
      if (this.metrics.msToFirstAudio === null && this.provider.getOutputVolume() > 0.02) {
        this.metrics.msToFirstAudio = Math.round(now - this.metrics.tStart);
      }
      this.renderer.setMouth(this.lipsync.update(dt));
      this.animRaf = requestAnimationFrame(loop);
    };
    this.animRaf = requestAnimationFrame(loop);

    try {
      await this.provider.connect();
    } catch (e) {
      await this.stopConversation(false);
      throw e;
    }
  }

  get lipSyncMode() {
    return this.lipsync && this.lipsync.hasRecentAlignment ? "visemas" : "energía";
  }

  _sendMetrics() {
    if (!this.metrics || this.metrics.demo) return;
    const m = {
      ...this.metrics,
      durationMs: Math.round(performance.now() - this.metrics.tStart),
      avgFps: Math.round(this.metrics.frames / Math.max(1, (performance.now() - this.metrics.tStart) / 1000)),
    };
    delete m.tStart; delete m.frames;
    try { navigator.sendBeacon("/api/metrics", new Blob([JSON.stringify(m)], { type: "application/json" })); } catch (e) {}
    this.metrics = null;
  }

  get active() { return !!this.provider; }

  async stopConversation(toIdle = true) {
    this._stopping = true;
    setTimeout(() => (this._stopping = false), 1500);
    cancelAnimationFrame(this.animRaf);
    this._sendMetrics();
    const p = this.provider;
    this.provider = null;
    if (this.lipsync) this.lipsync.reset();
    this.renderer.setMouth({ open: 0, width: 1 });
    if (p) { try { await p.disconnect(); } catch (e) {} }
    if (toIdle) this._setState("idle");
  }

  getOutputVolume() { return this.provider ? this.provider.getOutputVolume() : 0; }

  dispose() {
    this.stopConversation(false);
    this.renderer.dispose();
  }
}
