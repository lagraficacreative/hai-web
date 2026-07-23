// EnergyLipSync — nivel MVP del briefing: abre/cierra la boca según la energía
// del audio del agente, con suavizado (ataque/caída), puerta de silencio y
// una variación sutil de anchura según el reparto de frecuencias.
// Contrato LipSyncDriver: update(dt) → { open: 0..1, width: ~0.85..1.15 }
// La versión avanzada (visemas por fonema) sustituirá esta clase sin tocar el resto.

export class EnergyLipSync {
  constructor(getVolume, getFrequencyData) {
    this.getVolume = getVolume || (() => 0);
    this.getFrequencyData = getFrequencyData || (() => null);
    this.open = 0;
    this.width = 1;
    this.gate = 0.015;      // por debajo de esto es silencio: boca cerrada
    this.attackTau = 0.05;  // s — rapidez al abrir
    this.releaseTau = 0.13; // s — rapidez al cerrar (más lenta = sin temblor)
  }

  update(dt) {
    const v = Math.max(0, Math.min(1, this.getVolume() || 0));
    let target = 0;
    if (v > this.gate) {
      target = Math.min(1, Math.pow((v - this.gate) / 0.3, 0.7));
    }
    const tau = target > this.open ? this.attackTau : this.releaseTau;
    this.open += (target - this.open) * (1 - Math.exp(-dt / tau));
    if (this.open < 0.02 && target === 0) this.open = 0;

    // Anchura: más agudos (i/e/s) → boca más estrecha; graves (a/o) → más ancha
    const freq = this.getFrequencyData();
    let widthTarget = 1;
    if (freq && freq.length) {
      let lo = 0, hi = 0;
      const mid = Math.floor(freq.length / 2);
      for (let i = 0; i < freq.length; i++) {
        if (i < mid) lo += freq[i]; else hi += freq[i];
      }
      const total = lo + hi;
      if (total > 0) widthTarget = 1.1 - 0.25 * (hi / total);
    }
    this.width += (widthTarget - this.width) * (1 - Math.exp(-dt / 0.12));
    return { open: this.open, width: this.width };
  }

  reset() { this.open = 0; this.width = 1; }
}

// ── VisemeLipSync — nivel avanzado del briefing ──
// Usa el alignment por caracteres que envía ElevenLabs con cada chunk de audio
// ({chars, char_start_times_ms, char_durations_ms}) para formar visemas reales
// (A/E/I/O/U/M-B-P/F-V/L/silencio), y la energía del audio como red de
// seguridad: sin energía la boca se cierra aunque el timeline diga otra cosa.
// Mismo contrato que EnergyLipSync: update(dt) → { open, width, round }.

const VISEMES = {
  A: { open: 0.9, width: 1.05, round: 0 },
  E: { open: 0.55, width: 1.12, round: 0 },
  I: { open: 0.32, width: 1.18, round: 0 },
  O: { open: 0.75, width: 0.82, round: 0.7 },
  U: { open: 0.38, width: 0.68, round: 1 },
  MBP: { open: 0, width: 1, round: 0 },
  FV: { open: 0.14, width: 1.06, round: 0 },
  L: { open: 0.42, width: 1.0, round: 0 },
  CONS: { open: 0.28, width: 1.05, round: 0 },
  SIL: { open: 0, width: 1, round: 0 },
};

function charToViseme(ch) {
  const c = ch.toLowerCase();
  if ("aáà".includes(c)) return "A";
  if ("eéè".includes(c)) return "E";
  if ("iíï".includes(c)) return "I";
  if ("oóò".includes(c)) return "O";
  if ("uúü".includes(c)) return "U";
  if ("mbp".includes(c)) return "MBP";
  if ("fv".includes(c)) return "FV";
  if ("l".includes(c)) return "L";
  if (/[a-zñç]/.test(c)) return "CONS";
  return "SIL"; // espacios, puntuación, números
}

export class VisemeLipSync {
  constructor(getVolume, getFrequencyData, opts = {}) {
    this.energy = new EnergyLipSync(getVolume, getFrequencyData);
    // Corrección de retraso audio↔imagen (ms). Positivo = los visemas van tarde.
    this.offsetMs = opts.offsetMs !== undefined ? opts.offsetMs : 140;
    this.timeline = []; // [{at (ms, reloj performance.now), viseme}]
    this.open = 0; this.width = 1; this.round = 0;
    this.lastAlignmentAt = 0;
  }

  // Llamar con cada evento de alignment del SDK. Los tiempos del evento son
  // relativos al chunk; lo anclamos al reloj local en el momento de llegada.
  addAlignment(a) {
    if (!a || !a.chars || !a.chars.length) return;
    const base = performance.now() + this.offsetMs;
    for (let i = 0; i < a.chars.length; i++) {
      this.timeline.push({ at: base + (a.char_start_times_ms[i] || 0), viseme: charToViseme(a.chars[i]) });
    }
    // Mantener el timeline acotado (descartar lo ya pasado hace >5 s)
    const cutoff = performance.now() - 5000;
    while (this.timeline.length > 600 || (this.timeline.length && this.timeline[0].at < cutoff)) this.timeline.shift();
    this.lastAlignmentAt = performance.now();
  }

  get hasRecentAlignment() { return performance.now() - this.lastAlignmentAt < 3000; }

  update(dt) {
    const e = this.energy.update(dt);
    // Sin alignment reciente (agente sin client_events o WS caído): energía sola
    if (!this.hasRecentAlignment) {
      this.open = e.open; this.width = e.width; this.round = 0;
      return { open: this.open, width: this.width, round: 0 };
    }
    const now = performance.now();
    let current = "SIL";
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      if (this.timeline[i].at <= now) { current = this.timeline[i].viseme; break; }
    }
    const v = VISEMES[current];
    // Puerta de energía: si el audio calla (interrupción, jitter), boca cerrada
    const gate = Math.min(1, e.open * 3);
    const tOpen = v.open * gate;
    const k = (tau) => 1 - Math.exp(-dt / tau);
    this.open += (tOpen - this.open) * k(tOpen > this.open ? 0.04 : 0.09);
    this.width += (v.width - this.width) * k(0.07);
    this.round += (v.round - this.round) * k(0.07);
    return { open: this.open, width: this.width, round: this.round };
  }

  reset() { this.timeline = []; this.open = 0; this.width = 1; this.round = 0; this.energy.reset(); }
}
