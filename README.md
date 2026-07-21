# hai-web

Web + "cerebro" de HAI Memories (https://hai.lagrafica.ai), desplegado en Coolify con el Dockerfile de este repo (Node 22 + Express + SQLite).

- `public/` — la web: landing, cuestionario (8 pasos), demo móvil (PWA), avatar en directo (avatar.html), cuentas (cuenta.html, mi-avatar.html).
- `server.js` — API: `/api/chat` (María), `/api/tts`, `/api/avatar-embed` (HeyGen LiveAvatar), `/api/health`, y cuentas privadas (`/api/auth/*`, `/api/human*`). Contraseñas con scrypt, sesiones con cookie firmada, límite de uso por visitante/usuario.

## Claves (secretos en Coolify, NUNCA en el repo)

En Coolify → recurso hai-web → Environment Variables:

- `ANTHROPIC_API_KEY` (Claude) **o** `OPENAI_API_KEY` — chat de María y chats privados.
- `ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID` por defecto) — voz clonada.
- `HEYGEN_API_KEY` — avatar en directo (LiveAvatar). Opcionales: `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`, `HEYGEN_CONTEXT_ID`, `HEYGEN_SANDBOX=false` para salir del modo prueba.
- `SESSION_SECRET` — cadena larga aleatoria; mantiene las sesiones al reiniciar.

## IMPORTANTE: almacenamiento persistente

Los usuarios y sus chats viven en SQLite en `/app/data`. En Coolify hay que añadir **Persistent Storage** montado en `/app/data` — sin eso, cada deploy borra las cuentas.

## Publicar cambios

Editar → commit → push a `main` → Deploy en Coolify (Commit SHA en HEAD).
