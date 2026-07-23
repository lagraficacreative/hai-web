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
