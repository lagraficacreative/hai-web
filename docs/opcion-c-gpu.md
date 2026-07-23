# Opción C — avatar neuronal en tiempo real (Fase 4b, pendiente de presupuesto)

Guía preparada para cuando se apruebe el gasto de GPU. Objetivo: calidad "HeyGen"
self-hosted — el vídeo real de la persona con la boca regenerada por IA frame a
frame — como **gama alta** junto al renderer 2.5D actual (que se mantiene como
estándar sin GPU).

## Stack elegido (licencias verificadas en la Fase 0)

- **[MuseTalk 1.5](https://github.com/TMElyralab/MuseTalk)** (Tencent) — lip sync
  neuronal en tiempo real (30 fps+ en V100; una RTX 4090 sobra). Licencia MIT,
  uso comercial permitido, modelos incluidos.
- **[LiveTalking](https://github.com/lipku/livetalking)** — servidor de streaming
  (WebRTC, interrupciones, varios modelos, conexiones concurrentes). Apache-2.0.
  ⚠️ Usar el modo **musetalk**, NO wav2lip (sus pesos son no comerciales).

## Infraestructura

| Opción | Coste | Notas |
|---|---|---|
| RunPod Community (RTX 4090) | ~0,34 $/h | por segundo; para demos y pruebas |
| RunPod Secure (RTX 4090) | ~0,69 $/h | SLA mejor; producción |
| Serverless RunPod | por segundo | arranque en frío 30-60 s: solo con warm pool |

Regla del briefing: **nunca GPU encendida sin conversación activa**. Estrategia
inicial: 1 instancia bajo demanda con arranque asumido, o warm pool de 1 para
demos comerciales. 1 GPU ≈ 1 sesión concurrente.

## Integración con hai-web (contratos ya preparados)

1. **Preparación del avatar** (una vez por avatar, offline): del vídeo de
   registro (`DATA_DIR/avatars/<slug>/registro.*`) LiveTalking genera su modelo.
   Encaja en `AvatarTrainingProvider`; coste estimado 0,5–2 $ por avatar.
2. **Sesión en vivo**: el navegador recibe el vídeo por WebRTC desde LiveTalking
   y le envía el audio del agente de ElevenLabs. Nuevo `WebRTCVideoRenderer`
   implementando el contrato `AvatarRenderer` (load/setState/setMouth/dispose) —
   el resto del módulo (provider, estados, páginas, panel) no se toca.
3. **Ruteo**: campo nuevo `engine` en la tabla `avatars` (`2d` | `neural`);
   `/avatar?id=x` elige renderer según la ficha.

## Pasos cuando se apruebe

1. Cuenta RunPod + fijar límite de gasto mensual (recomendado 50–100 €).
2. Pod RTX 4090 con la imagen de LiveTalking; probar con el vídeo de registro de Montse.
3. Medir: latencia audio→frame, fps, VRAM, coste/min real.
4. `WebRTCVideoRenderer` + campo `engine` + botón en el panel de avatares.
5. Decidir pricing de la gama alta con el coste real medido.
