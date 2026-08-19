# RM Selection — Proyecto Central de Organización

**Última actualización:** 2026-08-18

## Propósito de este documento

Esta es la fuente central de organización de RM Selection. No reemplaza el código
ni la base de datos — describe el ESTADO REAL de lo que ya existe, qué funciona,
qué está a medio camino y qué sigue pendiente, para que ningún trabajo nuevo
reconstruya, contradiga o pierda algo que ya funciona.

**Regla de uso, antes de tocar cualquier área:** revisar esta sección, confirmar
qué ya existe y funciona, reutilizarlo, y reparar solo lo necesario. No se
reemplaza un sistema funcionando por uno nuevo sin necesidad real.

**Sistema de estados** (uno de estos cuatro por cada ítem, nunca "terminado" por
default):

- **Pendiente** — no empezado, o bloqueado por algo externo (ej. protección
  técnica de un sitio, o algo que solo puede resolver Ramon).
- **En progreso** — código escrito pero todavía no probado de punta a punta, o
  con partes reales sin completar.
- **Resuelta** — el código está escrito, compila/pasa `tsc`, y se desplegó a
  producción, pero todavía falta una corrida real (automática o de un usuario)
  que confirme que funciona con datos reales.
- **Verificada en producción** — hay evidencia concreta de que funcionó con
  datos reales (una venta real, una corrida real del cron, una prueba en
  dispositivo físico), no solo que el código compiló.

RM Selection es y sigue siendo una herramienta especializada de selección de
yearlings para pinhooking — no una app general de administración de caballos.

---

## Arquitectura real hoy (resumen técnico)

- **Backend**: un solo servicio Railway (Node/Express + `node-cron`), Postgres
  (Prisma), Cloudflare R2 para media que sube el usuario. Repo:
  `rm-selection-backend` en GitHub, rama `main`.
- **iOS**: app SwiftUI/SwiftData (proyecto en `RMSelection/`), con `SyncEngine`
  propio (patrón outbox) contra el backend.
- **Casas de venta soportadas por arquitectura** (`SaleHouse` enum):
  Fasig-Tipton, Keeneland, OBS — con un `SaleHouseClient` por casa
  (`saleHouses/*.ts`) desacoplado del resto del sistema (análisis, ranking,
  Historial de Ventas no saben ni necesitan saber de qué casa vino un Hip).
- **Modelo de datos actual** (`schema.prisma`): `Organization`, `User`,
  `Device`, `Sale`, `SaleDay`, `CatalogImport`, `SaleAlert`, `Hip`,
  `HorseSaleHistory`, `OfficialSaleResult`, `AnalysisResult`,
  `CurrentHipAnalysis`, `UserDecision`, `PedigreeAnnotation`,
  `HipObservation`, `VetReport`, `MediaAsset`, `RankingSnapshot`,
  `RankingSnapshotVersion`, `SchedulerRun`, `MediaSweepRun`, `ReferenceHorse`,
  `ReferenceHorsePhoto`.
- **Job nocturno único, 3:00 a.m.** (`scheduler.ts` →
  `runNightlySyncCycle`): 1) descubrimiento de ventas nuevas, 2) auto-resolución
  de ID de Fasig-Tipton, 3) sincronización de catálogo/precios, 4) barrido de
  Media. Un solo horario fijo — no hay otra cadencia para esto.
- **Precio en vivo**: cron aparte cada 10 min, SOLO durante una jornada de
  venta en curso, SOLO para la ventana de Decisión.

---

## 1. Catálogos y casas de venta

| Ítem | Estado | Notas |
|---|---|---|
| Fasig-Tipton — catálogo vía API | Verificada en producción | Importado y sincronizado repetidamente (Saratoga, New York Bred Yearlings). |
| Fasig-Tipton — auto-resolución del ID interno de venta (Chromium headless) | Resuelta | Implementado y probado en vivo hoy (17-18/8) contra 2 ventas reales (NY Bred Yearlings → 314, correcto; Kentucky October → null, correcto). Falta la primera corrida real del cron de 3am contra una venta `PENDING_ID` real para cerrarlo como Verificada. |
| Keeneland — catálogo vía API | Verificada en producción | September 2026 importado completo, ID corregido, catálogo aún-no-publicado manejado sin error. |
| OBS — catálogo | **Pendiente (bloqueado)** | `obscatalog.com` devuelve 403 Forbidden incluso a un navegador real — protección técnica activa, no se evade. No hay ningún mecanismo legítimo disponible hoy. Queda documentado como no implementable mientras esa protección exista. |
| Descarga automática de catálogos (arquitectura por casa) | Verificada en producción | Provider pattern generalizado; Fasig-Tipton y Keeneland confirmados funcionando de forma independiente. |
| Pedigrees | Verificada en producción | Mecanismo descubierto en Fasig-Tipton y replicado en Keeneland, probado con Hips reales (inicio/medio/final del catálogo). |
| Rangos de HIP (min/max real por venta) | Verificada en producción | UI muestra "Hips X–Y · N caballos"; navegación usa el primer Hip real disponible. |
| Calendario de ventas | Verificada en producción (Keeneland, Fasig-Tipton) | Modelo `SaleDay` generalizado por casa; probado con Fasig-Tipton New York. |
| Calendario de ventas — OBS | Pendiente | Arquitectura lista para recibir datos de OBS el día que haya un mecanismo de catálogo — no hay venta activa para probarlo. |

## 2. Automatización

| Ítem | Estado | Notas |
|---|---|---|
| Job nocturno único 3:00 a.m. (descubrimiento + auto-resolución ID + catálogo/precios + Media) | Verificada en producción | Consolidado desde 3 cadencias distintas a una sola; logs confirmados en Railway. |
| Precio en vivo cada 10 min (solo ventana Decisión, venta en curso) | Resuelta | Código desplegado y verificado por `tsc`/logs de arranque; falta confirmarlo durante una jornada de venta real en curso. |
| Detección automática de ventas nuevas (Fasig-Tipton/Keeneland/OBS) | Verificada en producción (Fasig-Tipton, Keeneland) | OBS solo detecta el ANUNCIO vía feed RSS — nunca pasa de ahí (ver fila OBS arriba). |
| Barrido diario de Media (fotos/video, incremental) | En progreso | Mecanismo construido, con distinción explícita "no publicado" vs "no encontrado" vs "falló descarga", e idempotencia confirmada (2 corridas seguidas sin duplicar). Prueba real en varios Hips desde iPhone/iPad todavía no se cerró de punta a punta. |
| Logs y verificación de cada corrida | Verificada en producción | Tablas `SchedulerRun` y `MediaSweepRun` + endpoints de historial, para no depender de logs de Railway que rotan. |

## 3. Análisis IA

| Ítem | Estado | Notas |
|---|---|---|
| Captura de fotografías (Front/Side/Rear) | En progreso | CORRECCIÓN 2026-08-18: Ramon reportó que seguía sin analizar fotos ni mostrar semáforo pese a fixes previos marcados "Verificada". Causa raíz real encontrada: Xcode estaba usando el selector de dispositivo del **canvas de Vista Previa** (solo afecta el lienzo interno de Xcode) en vez del selector real de **destino de Ejecución** (barra superior) — el código corregido compilaba, pero no se instalaba de forma confiable en los dispositivos físicos. Recién ahora se compiló e instaló el código actual en ambos dispositivos reales, confirmado por Xcode con el Device Identifier/Model real de cada uno (iPhone de Ramon 2, iPad de Ramon). Falta que Ramon confirme visualmente en ambos dispositivos. |
| Reconocimiento automático de vista (Front/Side/Rear) | En progreso | Mismo motivo que la fila de arriba — el código está corregido (regla estricta tarjeta↔vista detectada, 2026-08-18) pero recién se instaló de verdad en los dispositivos físicos en esta sesión. Pendiente confirmación visual de Ramon. |
| Validación verde/rojo por foto | En progreso | Validación apenas se toma cada foto (no recién al completar las 3); reemplazo de foto rechazada confirmado (rojo→verde) en código — pendiente reconfirmar en los dispositivos ya con el build correcto instalado (ver nota de causa raíz arriba). |
| Análisis vía backend oficial vs. respaldo local en el dispositivo | Pendiente (bloqueado) | El bucket de Cloudflare R2 sigue sin configurar en Railway (confirmado: ninguna variable `R2_*` existe en producción) — por lo tanto `POST /me/media` devuelve 503 de forma permanente y el análisis "oficial" en backend nunca puede completarse. La app cae automáticamente al análisis local en el dispositivo (llamada directa a Anthropic), que NO depende de R2 pero sí requiere que cada dispositivo tenga guardada su propia clave de API de Anthropic (Ajustes, dentro de la pestaña Análisis IA) — si falta esa clave en un dispositivo puntual, esa pantalla se ve vacía/sin semáforo. Crear el bucket R2 requiere una cuenta de Cloudflare — intervención de Ramon. |
| Comparación contra el caballo referente | Verificada en producción | Motor anatómico determinístico (landmarks + geometría + biblioteca de conformación), con calibración del referente por vista. |
| Hallazgos anatómicos — motor general | Verificada en producción | Reglas de prioridad RM, severidad + confianza, findings prioritizer. |
| Hallazgos anatómicos — estabilización de mediciones específicas | En progreso | `baseWidthRatio` (Frontal) estabilizado y confirmado con 10 corridas reales. Consistencia izquierda/derecha y `toe_in`/`toe_out`/`hoof_asymmetry` con fix aplicado pero sin la ronda final de verificación repetida. |
| Puntajes y clasificación (Excelente/Bien/Revisar) | Verificada en producción | Motor de scoring determinístico por vista (FRONT/SIDE/REAR). |
| Reproducibilidad (misma foto → mismo resultado) | Verificada en producción | `temperature=0`, cache de calibración con salt de versión, timeout explícito en llamadas a IA — confirmado con pruebas repetidas documentadas. |
| Pantalla de resultados Análisis (IA) | Verificada en producción | Layout responsive iPad/iPhone, miniaturas de las 3 fotos del referente, idioma ES/EN auditado y corregido. |

## 4. Favoritos y decisiones

| Ítem | Estado | Notas |
|---|---|---|
| Clasificación Excelente / Bien / Revisar | Verificada en producción | — |
| Paso automático a Mis Favoritos — Fasig-Tipton | Verificada en producción | Causa raíz reparada (importador CSV local ahora también sube al servidor). |
| Paso automático a Mis Favoritos — Keeneland | En progreso | Falta replicar el mismo fix aplicado a Fasig-Tipton; Barn todavía puede faltar en Mis Favoritos para esta casa. |
| Número de Barn — Fasig-Tipton | Verificada en producción | Propagado a través de todo el pipeline genérico por casa. |
| Número de Barn — Keeneland | En progreso | Mismo trabajo pendiente que Mis Favoritos arriba. |
| Precio de venta en Decisión — Fasig-Tipton Saratoga | Verificada en producción | Confirmado con `sale_id` real conocido. |
| Precio de venta en Decisión — Fasig-Tipton New York | En progreso | Diagnóstico de causa raíz en curso al cierre de esta sesión — no se confirmó reparado todavía. |
| Sincronización entre ventas y dispositivos (servidor) | Verificada en producción | `UserDecision`, `HipObservation`, `VetReport`, `MediaAsset` (subida en dos fases a R2), puntaje manual — todo expuesto vía `/api/v1/me/*`. |
| Sincronización entre ventas y dispositivos (iOS, `SyncEngine`) | En progreso | Motor construido y desplegado (patrón outbox, reconexión automática); pruebas físicas de punta a punta en iPad/iPhone reales (escribir, zoom, pan, persistencia) no se cerraron formalmente. |

## 5. Interfaz

| Ítem | Estado | Notas |
|---|---|---|
| Barra de navegación iPhone (una sola fila) | Verificada en producción | — |
| Layout Análisis IA — iPad (aprovechando espacio) | Verificada en producción | — |
| Orden de pestañas del Hip (Pedigree→Media→Reporte Vet→Análisis→Notas→Decisión) | Verificada en producción | — |
| Regla global "Hip siempre abre en Pedigree" | Verificada en producción | Incluye la corrección de que el Calendario abra el Pedigree real (no uno reconstruido). |
| Calendario de ventas (UI) | Verificada en producción | — |
| Idioma ES/EN | Verificada en producción | Auditoría completa realizada; FRONTAL/LATERAL/POSTERIOR y mezclas de idioma corregidas. |
| Velocidad de navegación entre pantallas | En progreso | Cacheo de listas ordenadas y corrección de recarga completa del catálogo ya desplegados; falta la medición final antes/después en dispositivo real que confirme la mejora percibida. |
| Anotaciones a mano (lápiz) en Pedigree | En progreso | Reescrito con lápiz vino tinto + borrador, ancla al documento con zoom/pan; prueba física completa en iPad (escribir, borrar, zoom, pan, persistencia, sync) sin cerrar formalmente. |

## 6. Backend y estabilidad

| Ítem | Estado | Notas |
|---|---|---|
| Railway (deploy, builds) | Verificada en producción | Deploy consolidado y estable; builds pasando limpio tras la corrección de hoy. |
| Base de datos (Postgres/Prisma) | Verificada en producción | Múltiples migraciones aplicadas sin pérdida de datos de producción. |
| Dependencias nuevas (`puppeteer-core`, `@sparticuz/chromium`) | Verificada en producción | Build limpio, app arranca sin crashear, resolver probado contra páginas reales. |
| `package-lock.json` | **Pendiente** | Se eliminó del repo como solución al build roto (Railway usa `npm install` sin lockfile) — deuda técnica reconocida: falta regenerarlo con `npm` real cuando haya forma de hacerlo (el entorno de este agente no tiene acceso al registro de npm). No afecta el funcionamiento actual. |
| Navegador headless (Chromium) en el backend | Resuelta | Ver fila de auto-resolución de Fasig-Tipton en la sección 1 — mismo ítem, pendiente de una corrida real del cron. |
| Logs y diagnóstico | Verificada en producción | Railway MCP + tablas `SchedulerRun`/`MediaSweepRun` para no depender solo de logs que rotan. |
| Manejo de errores / recuperación | Verificada en producción | Ejemplos confirmados: catálogo aún-no-publicado sin error feo, 401 real en API sin key, reintentos de descubrimiento tolerantes a fallos de una sola casa. |

---

## Reglas para mantener este documento vivo

1. Antes de empezar cualquier tarea nueva, releer la fila correspondiente acá.
2. Al terminar una tarea, actualizar el estado con evidencia real (no marcar
   "Verificada en producción" solo porque compiló).
3. Si una función depende de un evento futuro (una venta real, la próxima
   corrida del cron, una prueba física de Ramon), queda en "Resuelta" o "En
   progreso" hasta que exista esa evidencia — nunca "Verificada" por
   anticipado.
4. OBS se mantiene separado como Pendiente en cada sección donde aplica,
   mientras siga existiendo la protección 403 de `obscatalog.com`.
5. Este archivo vive en el repo del backend (`RM_SELECTION_PROJECT.md`, raíz)
   junto con `ARCHITECTURE.md` y `README.md` — se actualiza en el mismo commit
   que el trabajo que describe, para que nunca quede desactualizado.
