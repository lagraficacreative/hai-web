// Aurora — al cargar, encuentra todos los .hero-bg de la página, les inyecta
// 3 blobs de color + un velo oscuro sutil, y arranca el bucle de parallax.
// En touch (móvil/tablet), sustituye el ratón por una curva de Lissajous lenta.
// Respeta prefers-reduced-motion.
(function () {
  const heroes = document.querySelectorAll(".hero-bg");
  if (!heroes.length) return;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const isTouch = matchMedia("(hover: none)").matches;
  const instances = [];

  heroes.forEach((bg) => {
    // Los tres blobs y el velo se añaden por JS para no ensuciar el HTML
    ["b1", "b2", "b3"].forEach((cls) => {
      const el = document.createElement("div");
      el.className = "aurora-blob " + cls;
      bg.appendChild(el);
    });
    const veil = document.createElement("div");
    veil.className = "aurora-veil";
    bg.appendChild(veil);

    const inst = {
      root: bg.parentElement,   // el <header class="hero"> normalmente
      blobs: [
        { el: bg.querySelector(".b1"), depth: 42 },
        { el: bg.querySelector(".b2"), depth: 30 },
        { el: bg.querySelector(".b3"), depth: 60 },
      ],
      curX: 0.5, curY: 0.5, targetX: 0.5, targetY: 0.5,
    };
    instances.push(inst);

    if (!isTouch) {
      inst.root.addEventListener("pointermove", (ev) => {
        const r = inst.root.getBoundingClientRect();
        inst.targetX = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
        inst.targetY = Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      });
      inst.root.addEventListener("pointerleave", () => { inst.targetX = 0.5; inst.targetY = 0.5; });
    }
  });

  // Modo móvil: recorrido autónomo Lissajous (dt en ms para independizarse del refresco)
  let tPrev = performance.now();
  let tt = 0;

  function tick(now) {
    const dt = Math.min(0.05, (now - tPrev) / 1000); tPrev = now;
    if (isTouch) {
      tt += dt * 0.3;
      const tx = 0.5 + Math.sin(tt * 1.3) * 0.28;
      const ty = 0.5 + Math.cos(tt * 0.9) * 0.22;
      instances.forEach((i) => { i.targetX = tx; i.targetY = ty; });
    }
    const k = reduced ? 0.02 : 0.045;
    for (const i of instances) {
      i.curX += (i.targetX - i.curX) * k;
      i.curY += (i.targetY - i.curY) * k;
      for (const b of i.blobs) {
        const dx = (i.curX - 0.5) * b.depth;
        const dy = (i.curY - 0.5) * b.depth;
        b.el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
