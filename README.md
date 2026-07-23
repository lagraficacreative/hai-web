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

## Avatar en tiempo real propio (módulo avatar-live)

Alternativa propia a LiveAvatar (informe Fase 0 en los artefactos del proyecto): render 2.5D en el navegador + conversación por ElevenLabs Agents.

- Rutas: `/avatar` (normal) y `/hologram` (fondo negro; params `?mirror=true&scale=0.7–1.6&debug=true`). `?demo=1` prueba sin claves ni micro. `?id=<nombre>` elige identidad de `public/avatar-live/identities/`.
- `GET /api/agents/token` — token efímero de sesión (WebRTC, con respaldo WebSocket). El agente se crea solo la primera vez con la persona de la web y `ELEVENLABS_VOICE_ID`; el log imprime su id → fijarlo como `ELEVENLABS_AGENT_ID` en Coolify.
- La `ELEVENLABS_API_KEY` necesita además los permisos de **Agents (ConvAI)** en el panel de ElevenLabs.
- Crear una identidad desde el vídeo de registro: `/avatar-live/crear-identidad.html` (todo en el navegador; exporta base.jpg + identity.json + idle.webm a `public/avatar-live/identities/<nombre>/`).
- El SDK va empaquetado en `public/avatar-live/vendor/` (regenerar con `npm run build:avatar-vendor`).
- LiveAvatar (avatar.html + `/api/avatar-embed`) sigue intacto como sistema alternativo.

## IMPORTANTE: almacenamiento persistente

Los usuarios y sus chats viven en SQLite en `/app/data`. En Coolify hay que añadir **Persistent Storage** montado en `/app/data` — sin eso, cada deploy borra las cuentas.

## Publicar cambios

Editar → commit → push a `main` → Deploy en Coolify (Commit SHA en HEAD).
