# hai-web

Web + "cerebro" de HAI Memories (https://hai.lagrafica.ai), desplegado en Coolify con el Dockerfile de este repo (Node + Express).

- `public/` — la web: landing, cuestionario (8 pasos), demo móvil (PWA).
- `server.js` — API del cerebro: `/api/chat` (IA con la personalidad del Human AI), `/api/tts` (voz clonada ElevenLabs), `/api/health`. Con límite de uso por visitante.

## Claves (secretos en Coolify, NUNCA en el repo)

En Coolify → recurso hai-web → Environment Variables:

- `ANTHROPIC_API_KEY` (Claude) **o** `OPENAI_API_KEY` — activa el chat. Si están las dos, usa Claude.
- `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` — activa la voz clonada.

Sin claves, la web sigue funcionando: María responde con las respuestas programadas y la demo pide claves propias en ⚙️.

## Publicar cambios

Editar → commit → push a `main` → Deploy en Coolify.
