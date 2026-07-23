// Hybrid2DRenderer — contrato AvatarRenderer del informe Fase 0 (opción D).
// Renderiza en <canvas> la imagen (o vídeo idle) real de la persona con:
//   - boca animada en tiempo real (caída de mandíbula + interior de boca)
//   - parpadeo automático cada 2–6 s
//   - respiración sutil y micro-movimientos de cabeza
//   - estados: idle · connecting · listening · thinking · speaking · interrupted · error
// Todo corre en el navegador; no hay GPU de servidor.
//
// La identidad se describe en identity.json (coordenadas sobre la imagen original):
//   { name, image | idleVideo, width, height,
//     mouth: {x,y,w,h}   rect de los labios cerrados
//     chinY              fila donde acaba la barbilla
//     eyes: [{x,y,w,h}]  rects de los ojos (opcional → sin parpadeo)
//     skin: "#hex"       color de párpado si no se puede muestrear
//     innerMouth: "#hex" color del interior de la boca (opcional) }

const STATE_MOTION = {
  idle:        { sway: 1.0, breath: 1.0, rotBias: 0,    yBias: 0 },
  connecting:  { sway: 0.5, breath: 1.0, rotBias: 0,    yBias: 0 },
  listening:   { sway: 0.6, breath: 1.0, rotBias: 2.2,  yBias: 2 },
  thinking:    { sway: 0.4, breath: 1.1, rotBias: -1.6, yBias: -3 },
  speaking:    { sway: 1.2, breath: 1.05, rotBias: 0,   yBias: 0 },
  interrupted: { sway: 0.2, breath: 1.0, rotBias: 1.2,  yBias: 1 },
  error:       { sway: 0.3, breath: 1.0, rotBias: 0,    yBias: 0 },
};

export class Hybrid2DRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.identity = null;
    this.source = null;          // HTMLImageElement o HTMLVideoElement
    this.isVideo = false;
    this.state = "idle";
    this.motion = { ...STATE_MOTION.idle };
    this.mouth = { open: 0, width: 1 };
    this.t = 0;
    this.raf = 0;
    this.last = 0;
    this.blink = 0;              // 0 = ojos abiertos, 1 = cerrados
    this.nextBlinkAt = 2 + Math.random() * 4;
    this.blinkStart = -1;
    this.lidColor = null;
    this.running = false;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  async load(identityUrl) {
    // Acepta una URL de identity.json o el objeto identidad directamente
    // (este último lo usa la herramienta crear-identidad para previsualizar).
    let id, base = "";
    if (typeof identityUrl === "string") {
      base = identityUrl.slice(0, identityUrl.lastIndexOf("/") + 1);
      id = await (await fetch(identityUrl)).json();
    } else {
      id = identityUrl;
    }
    this.identity = id;
    if (id.idleVideo) {
      const v = document.createElement("video");
      v.src = id.idleVideo.startsWith("blob:") ? id.idleVideo : base + id.idleVideo;
      v.muted = true; v.loop = true; v.playsInline = true;
      await v.play().catch(() => {});      // si autoplay falla, arranca en start()
      this.source = v; this.isVideo = true;
    } else {
      const img = new Image();
      img.src = /^(blob:|data:|https?:|\/)/.test(id.image) ? id.image : base + id.image;
      await img.decode();
      this.source = img; this.isVideo = false;
    }
    // Las coordenadas de identity.json están en el espacio id.width×id.height,
    // pero la fuente puede tener otro tamaño intrínseco (p. ej. un SVG o un
    // vídeo re-escalado): sx/sy convierten identidad → píxeles de la fuente.
    const srcW = this.isVideo ? this.source.videoWidth : this.source.naturalWidth;
    const srcH = this.isVideo ? this.source.videoHeight : this.source.naturalHeight;
    this.sx = (srcW || id.width) / id.width;
    this.sy = (srcH || id.height) / id.height;
    this._sampleLidColor();
    return this;
  }

  _sampleLidColor() {
    const id = this.identity;
    if (!id.eyes || !id.eyes.length) return;
    if (id.skin) { this.lidColor = id.skin; return; }
    try {
      const c = document.createElement("canvas");
      c.width = id.width; c.height = id.height;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(this.source, 0, 0, id.width, id.height);
      const e = id.eyes[0];
      const p = x.getImageData(Math.round(e.x + e.w / 2), Math.round(e.y - e.h * 0.9), 1, 1).data;
      this.lidColor = `rgb(${p[0]},${p[1]},${p[2]})`;
    } catch (err) { this.lidColor = "#d8b49c"; }
  }

  setState(state) {
    this.state = state;
    // La transición de movimiento se hace suavizando hacia STATE_MOTION en _tick
  }

  setMouth(m) { this.mouth = m; }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.isVideo) this.source.play().catch(() => {});
    this.last = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this._tick(dt);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  _tick(dt) {
    this.t += dt;
    const id = this.identity;
    const cv = this.canvas;
    const ctx = this.ctx;

    // Ajuste de resolución al contenedor (responsive + retina)
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = cv.clientWidth, cssH = cv.clientHeight;
    if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
      cv.width = Math.round(cssW * dpr);
      cv.height = Math.round(cssH * dpr);
    }

    // Movimiento objetivo del estado actual, con transición suave
    const target = STATE_MOTION[this.state] || STATE_MOTION.idle;
    const k = 1 - Math.exp(-dt / 0.5);
    for (const key of Object.keys(target)) {
      this.motion[key] += (target[key] - this.motion[key]) * k;
    }
    const m = this.motion;
    const calm = this.reducedMotion ? 0.25 : 1;

    // Parpadeo cada 2–6 s (140 ms), pausado si reduced-motion extremo no: parpadear es natural
    if (this.blinkStart < 0 && this.t >= this.nextBlinkAt) this.blinkStart = this.t;
    if (this.blinkStart >= 0) {
      const p = (this.t - this.blinkStart) / 0.14;
      this.blink = p >= 1 ? 0 : Math.sin(Math.min(1, p) * Math.PI);
      if (p >= 1) { this.blinkStart = -1; this.nextBlinkAt = this.t + 2 + Math.random() * 4; }
    }

    // Encaje "contain" de la imagen en el canvas
    const scale = Math.min(cv.width / id.width, cv.height / id.height);
    const dw = id.width * scale, dh = id.height * scale;
    const ox = (cv.width - dw) / 2, oy = (cv.height - dh) / 2;

    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.save();

    // Cabeza: respiración + vaivén + sesgo del estado (pivote en la base)
    const breath = 1 + 0.004 * m.breath * calm * Math.sin(this.t * (2 * Math.PI / 4.6));
    const sway =
      0.35 * Math.sin(this.t * 0.31) + 0.25 * Math.sin(this.t * 0.53 + 1.7);
    const nod = this.state === "speaking" ? this.mouth.open * 1.5 : 0;
    const rot = ((sway * m.sway + m.rotBias) * calm * Math.PI) / 180;
    ctx.translate(ox + dw / 2, oy + dh);
    ctx.rotate(rot);
    ctx.scale(breath, breath);
    ctx.translate(-dw / 2, -dh + (m.yBias + nod) * calm * scale);

    // ── Boca: caída de mandíbula ──
    // 1) retrato completo estático; 2) la franja labios→barbilla estirada
    // hacia abajo por encima (la barbilla "baja" y tapa un poco el cuello).
    const S = this.source;
    const mouthCY = id.mouth.y + id.mouth.h * 0.45;      // línea entre labios
    const drop = this.mouth.open * id.mouth.h * 0.55 * scale;

    ctx.drawImage(S, 0, 0, id.width * this.sx, id.height * this.sy, 0, 0, dw, dh);
    if (drop > 0.5) {
      const bandH = id.chinY - mouthCY;
      ctx.drawImage(S, 0, mouthCY * this.sy, id.width * this.sx, bandH * this.sy,
        0, mouthCY * scale, dw, bandH * scale + drop);
    }

    // Interior de la boca al abrirse
    if (drop > 1) {
      const mw = id.mouth.w * scale * 0.5 * this.mouth.width;
      const mx = (id.mouth.x + id.mouth.w / 2) * scale;
      ctx.fillStyle = id.innerMouth || "#331418";
      ctx.beginPath();
      ctx.ellipse(mx, mouthCY * scale + drop * 0.5, mw, drop * 0.52, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Párpados (parpadeo y ojos entrecerrados en "thinking")
    const lid = Math.max(this.blink, this.state === "thinking" ? 0.25 : 0);
    if (lid > 0.02 && id.eyes && this.lidColor) {
      ctx.fillStyle = this.lidColor;
      for (const e of id.eyes) {
        const h = e.h * lid * 1.15;
        this._roundRect(ctx, e.x * scale, (e.y - e.h * 0.08) * scale, e.w * scale, h * scale, e.w * scale * 0.3);
      }
    }

    ctx.restore();
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.isVideo && this.source) { this.source.pause(); this.source.src = ""; }
    this.source = null;
  }
}
