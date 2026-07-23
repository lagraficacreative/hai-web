// Orquestador del avatar en tiempo real: une ConversationProvider + LipSyncDriver
// + AvatarRenderer. Es la única pieza que conocen las páginas /avatar y /hologram.
// Cambiar de motor (p. ej. renderer neuronal WebRTC en Fase 4) = cambiar aquí una clase.

import { Hybrid2DRenderer } from "./renderer2d.js";
import { EnergyLipSync } from "./lipsync.js";
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
  constructor({ canvas, identityUrl, demo = false, onState = () => {}, onError = () => {}, onTranscript = () => {} }) {
    this.renderer = new Hybrid2DRenderer(canvas);
    this.identityUrl = identityUrl;
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
    this.provider = this.demo ? new DemoProvider() : new ElevenLabsAgentsProvider();
    this.provider
      .on("state", (s) => this._setState(s))
      .on("error", (msg) => this.onError(msg))
      .on("transcript", (t) => this.onTranscript(t));

    this.lipsync = new EnergyLipSync(
      () => (this.provider ? this.provider.getOutputVolume() : 0),
      () => (this.provider ? this.provider.getOutputByteFrequencyData() : null)
    );

    // Bucle de lip sync independiente del render (mismo rAF cadence)
    this.lastT = performance.now();
    const loop = (now) => {
      if (!this.provider) return;
      const dt = Math.min(0.05, (now - this.lastT) / 1000);
      this.lastT = now;
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

  get active() { return !!this.provider; }

  async stopConversation(toIdle = true) {
    cancelAnimationFrame(this.animRaf);
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
