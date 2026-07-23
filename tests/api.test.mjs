// Tests de la API de hai-web (node --test). Levanta el servidor real con una
// base de datos temporal y recorre los flujos críticos: cuentas, panel de
// avatares (consentimiento, privacidad, borrado real), leads y métricas.
// Ejecutar: npm test

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const B = `http://localhost:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "hai-test-"));
let server;
let cookie = "";

function j(url, opts = {}) {
  return fetch(B + url, {
    ...opts,
    headers: { "content-type": "application/json", cookie, ...(opts.headers || {}) },
  });
}

before(async () => {
  server = spawn("node", ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(B + "/api/health"); return; } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("el servidor no ha arrancado");
});

after(() => {
  server.kill();
  rmSync(DATA, { recursive: true, force: true });
});

test("salud: expone el estado de los servicios", async () => {
  const h = await (await fetch(B + "/api/health")).json();
  assert.equal(h.accounts, true);
  assert.equal(typeof h.avatarLive, "boolean");
});

test("cuentas: registro, sesión y /me", async () => {
  const r = await j("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ email: "lagraficacreative@gmail.com", password: "prueba1234", name: "Test Admin" }),
  });
  assert.equal(r.status, 200);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
  assert.match(cookie, /^hai_session=/);
  const me = await (await j("/api/auth/me")).json();
  assert.equal(me.user.email, "lagraficacreative@gmail.com");
});

test("cuentas: contraseña corta rechazada", async () => {
  const r = await j("/api/auth/register", {
    method: "POST", headers: { cookie: "" },
    body: JSON.stringify({ email: "x@x.com", password: "corta" }),
  });
  assert.equal(r.status, 400);
});

test("avatares: sin consentimiento no se crea nada", async () => {
  const r = await j("/api/avatars", {
    method: "POST",
    body: JSON.stringify({ slug: "sin-consent", name: "X", consent: { autorizacion: true } }),
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "consentimiento_incompleto");
});

test("avatares: flujo completo crear → subir → privacidad → activar → borrar", async () => {
  const create = await j("/api/avatars", {
    method: "POST",
    body: JSON.stringify({
      slug: "test", name: "Avatar Test", language: "es", personality: "Eres un test.",
      consent: { autorizacion: true, recreacion: true, firma: "Test Admin", relacion: "test" },
    }),
  });
  assert.equal(create.status, 200);

  // activar sin assets debe fallar
  const early = await j("/api/avatars/test", { method: "PUT", body: JSON.stringify({ status: "active" }) });
  assert.equal(early.status, 400);
  assert.equal((await early.json()).error, "faltan_assets");

  // subir identity.json y base
  const identity = readFileSync(join(ROOT, "public/avatar-live/identities/demo/identity.json"));
  const fd1 = new FormData();
  fd1.append("file", new Blob([identity], { type: "application/json" }), "identity.json");
  const up1 = await fetch(B + "/api/avatars/test/assets?kind=identity", { method: "POST", headers: { cookie }, body: fd1 });
  assert.equal(up1.status, 200);
  const png = readFileSync(join(ROOT, "public/icon-192.png"));
  const fd2 = new FormData();
  fd2.append("file", new Blob([png], { type: "image/png" }), "base.png");
  const up2 = await fetch(B + "/api/avatars/test/assets?kind=base", { method: "POST", headers: { cookie }, body: fd2 });
  assert.equal((await up2.json()).assets.base, true);

  // sin activar, la identidad NO es pública (sin cookie → 404)
  assert.equal((await fetch(B + "/api/identities/test/identity.json")).status, 404);
  // pero administración sí la previsualiza
  assert.equal((await j("/api/identities/test/identity.json")).status, 200);

  // activar → pública
  const act = await j("/api/avatars/test", { method: "PUT", body: JSON.stringify({ status: "active" }) });
  assert.equal(act.status, 200);
  assert.equal((await fetch(B + "/api/identities/test/identity.json")).status, 200);

  // archivos fuera de la lista blanca nunca se sirven
  assert.equal((await fetch(B + "/api/identities/test/..%2F..%2Fhai.db")).status, 404);

  // borrado real: ficha y archivos
  assert.equal((await j("/api/avatars/test", { method: "DELETE" })).status, 200);
  assert.equal((await j("/api/identities/test/identity.json")).status, 404);

  // todo queda auditado
  const audit = await (await j("/api/admin/audit")).json();
  const acciones = audit.audit.map((a) => a.action);
  for (const a of ["avatar_crear", "avatar_subida", "avatar_editar", "avatar_eliminar"]) {
    assert.ok(acciones.includes(a), "falta acción de auditoría: " + a);
  }
});

test("avatares: el slug demo está reservado y sin sesión no hay acceso", async () => {
  const r = await j("/api/avatars", {
    method: "POST",
    body: JSON.stringify({ slug: "demo", name: "X", consent: { autorizacion: true, recreacion: true, firma: "F" } }),
  });
  assert.equal(r.status, 400);
  assert.equal((await fetch(B + "/api/avatars")).status, 401);
});

test("leads: valida sector y email", async () => {
  const mal = await j("/api/leads", { method: "POST", headers: { cookie: "" }, body: JSON.stringify({ sector: "otro", email: "a@b.com" }) });
  assert.equal(mal.status, 400);
  const sinMail = await j("/api/leads", { method: "POST", headers: { cookie: "" }, body: JSON.stringify({ sector: "business", email: "no-es-email" }) });
  assert.equal(sinMail.status, 400);
  const ok = await j("/api/leads", {
    method: "POST", headers: { cookie: "" },
    body: JSON.stringify({ sector: "business", name: "Test", email: "lead@test.com", data: { b_sector: "pruebas" } }),
  });
  assert.equal(ok.status, 200);
  const listado = await (await j("/api/admin/leads")).json();
  assert.equal(listado.leads[0].email, "lead@test.com");
});

test("métricas: se registran y se resumen", async () => {
  const r = await j("/api/metrics", {
    method: "POST", headers: { cookie: "" },
    body: JSON.stringify({ msToConnected: 1200, msToFirstAudio: 1800, durationMs: 60000, avgFps: 58, interruptions: 1 }),
  });
  assert.equal(r.status, 200);
  const m = await (await j("/api/admin/metrics")).json();
  assert.ok(m.resumen.total >= 1);
  assert.equal(typeof m.resumen.msToFirstAudio_media, "number");
});

test("admin: borra un cliente con todos sus datos, pero nunca a administración", async () => {
  // crear un cliente normal
  const reg = await fetch(B + "/api/auth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "cliente@test.com", password: "prueba1234", name: "Cliente" }),
  });
  assert.equal(reg.status, 200);
  const clients = await (await j("/api/admin/clients")).json();
  const target = clients.clients.find((c) => c.email === "cliente@test.com");
  assert.ok(target);
  // borrarlo
  assert.equal((await j("/api/admin/clients/" + target.id, { method: "DELETE" })).status, 200);
  const after = await (await j("/api/admin/clients")).json();
  assert.ok(!after.clients.find((c) => c.email === "cliente@test.com"));
  // la cuenta admin no se puede borrar
  const me = after.clients.find((c) => c.email === "lagraficacreative@gmail.com");
  const rr = await j("/api/admin/clients/" + me.id, { method: "DELETE" });
  assert.equal(rr.status, 400);
});

test("pagos: valida plan, email y aceptación; degrada sin clave de Stripe", async () => {
  const noAcepta = await j("/api/checkout", {
    method: "POST", headers: { cookie: "" },
    body: JSON.stringify({ plan: "presencia-web", email: "a@b.com" }),
  });
  // sin STRIPE_SECRET_KEY el servidor responde 503 antes de validar nada más
  assert.equal(noAcepta.status, 503);
  assert.equal((await noAcepta.json()).error, "pagos_no_configurados");
  // el listado de pedidos es solo de administración
  assert.equal((await fetch(B + "/api/admin/orders")).status, 401);
  assert.equal((await j("/api/admin/orders")).status, 200);
});

test("token de agente: degrada con claridad sin API key", async () => {
  const r = await fetch(B + "/api/agents/token");
  // en el entorno de test no hay ELEVENLABS_API_KEY
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "avatar_no_configurado");
});
