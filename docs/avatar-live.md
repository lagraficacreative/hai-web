# avatar-live — avatar conversacional en tiempo real

Módulo propio que sustituye (y convive con) LiveAvatar. Informe Fase 0 y decisiones: artefacto "HAI · Avatar en tiempo real — Informe Fase 0".

## Piezas

| Pieza | Archivo | Qué hace |
|---|---|---|
| Orquestador | `public/avatar-live/hai-avatar.js` | Une provider + lip sync + renderer; estados; métricas de sesión |
| Conversación | `public/avatar-live/providers.js` | `ElevenLabsAgentsProvider` (SDK oficial, WebRTC con respaldo WS; micro, turnos, interrupciones, alignment) y `DemoProvider` (`?demo=1`, sin claves) |
| Lip sync | `public/avatar-live/lipsync.js` | `EnergyLipSync` (energía, MVP) y `VisemeLipSync` (visemas por carácter con el alignment de ElevenLabs + energía como red de seguridad). Contrato común: `update(dt) → {open, width, round}` |
| Renderer | `public/avatar-live/renderer2d.js` | `Hybrid2DRenderer` (canvas 2.5D): retrato o vídeo idle real + mandíbula/labios paramétricos + parpadeo + respiración + estados. Contrato `AvatarRenderer` — sustituible por un renderer WebRTC neuronal (opción C, Fase 4b) sin tocar el resto |
| Páginas | `avatar.html`, `hologram.html` | Rutas `/avatar` y `/hologram` (params `id`, `demo`, y en holograma `mirror`, `scale` 0.7–1.6, `debug`) |
| Identidades | estáticas en `identities/<slug>/` (solo `demo`) o dinámicas en `DATA_DIR/avatars/<slug>/` servidas por `/api/identities/<slug>/…` | `identity.json` (+`base.jpg`, `idle.webm`): coordenadas de boca/ojos/barbilla sobre la imagen |
| Herramienta | `crear-identidad.html` | Del vídeo de registro a los 3 archivos de identidad, 100 % en el navegador |
| Panel | `avatares.html` (admin) | Alta con consentimiento firmado, material, voz/agente por avatar, activar/desactivar, borrado real, auditoría |

## Servidor (server.js)

- `GET /api/agents/token[?id=<slug>]` — token WebRTC efímero (respaldo: URL firmada WS). Sin `id` usa el agente global (`ELEVENLABS_AGENT_ID` o se crea por nombre); con `id`, el agente del avatar (se crea con su personalidad/idioma/voz si la ficha no tiene `agent_id`).
- Los agentes se crean con `tts.model_id: eleven_flash_v2_5` (obligatorio en no-inglés) y `conversation.client_events` incluyendo `alignment` (visemas). A los agentes ya existentes se les hace PATCH una vez por proceso (`ensureXiClientEvents`).
- `POST /api/metrics` (anónimo, sendBeacon al terminar sesión) y `GET /api/admin/metrics` (resumen: ms a conectado, ms a primer audio, fps, duración, interrupciones).
- CRUD de avatares + subida de material + auditoría: ver README.

## Sincronización de visemas

ElevenLabs envía con cada chunk de audio `{chars, char_start_times_ms, char_durations_ms}`. `VisemeLipSync` ancla esos tiempos al reloj local en el momento de llegada + `offsetMs` (140 ms por defecto, corregible), mapea carácter→visema (A/E/I/O/U/MBP/FV/L/consonante/silencio, mapeo pensado para es/ca) y aplica una puerta de energía: si el audio real calla, la boca se cierra aunque el timeline diga otra cosa. Sin alignment (agente sin el client_event, red caída) degrada solo a energía.

## Tests y métricas

- `npm test` — suite `tests/api.test.mjs` (node:test): cuentas, consentimiento, privacidad de identidades, borrado real, auditoría, leads, métricas.
- Debug en vivo: `/hologram?demo=1&debug=true` (estado, volumen, fps, modo de lip sync, latencias).

## Pendiente (Fase 4b)

Opción C del informe: MuseTalk (MIT) servido con LiveTalking (Apache-2.0) en GPU (RunPod ~0,34–0,69 $/h por sesión), detrás de un `WebRTCVideoRenderer` que implemente el contrato `AvatarRenderer`. Decisión de presupuesto pendiente.
