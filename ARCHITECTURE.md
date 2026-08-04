# RM Selection Backend — Arquitectura (revisada antes del deploy a Railway)

Este documento define la arquitectura del backend pensando en el Ranking del Día
de hoy y en las funciones futuras: sincronización entre dispositivos, cuentas de
usuario, multi-tenant (varios compradores independientes), resultados históricos y
crecimiento general de la plataforma. Se escribe ANTES de crear la cuenta de
Railway a propósito — los cambios de esquema de base de datos son gratis ahora (no
hay datos en producción todavía) y caros después (migración contra datos reales).

## 0. Estado actual (ya implementado, antes del deploy)

- Un solo servicio Railway corre la API (Express) y el scheduler (`node-cron`) en el
  mismo proceso.
- Autenticación: `x-api-key` identifica un `User` real (no una clave suelta), y ese
  `User` pertenece a una `Organization`.
- `AnalysisResult` NO se sobrescribe: cada análisis queda como fila nueva
  (historial completo por Hip **y por organización**).
- `RankingSnapshot` se sobrescribe (lectura rápida); `RankingSnapshotVersion` guarda
  el historial completo de recálculos.
- Multi-tenant: `Organization` ya existe en el esquema — ver sección 1a.
- Robustez de scheduler: transacciones, guard contra ciclos superpuestos,
  presupuesto de análisis por ciclo, y registro `SchedulerRun` — ver sección 4.
- Las decisiones del usuario (`UserDecision`) y las observaciones (`HipObservation`)
  ya tienen rutas server-side (`/api/v1/me/*`) listas para sincronizar, pero la app
  de iOS todavía las guarda solo en SwiftData local — ver sección 3.

## 1. Qué tiene el esquema

- **`User`**: `id`, `organizationId`, `email?`, `apiKey?`, `displayName?`, `role`.
  Sin esto, "sincronizar entre dispositivos" y "cuentas de usuario futuras" no
  tienen dónde anclarse.
- **`Device`**: `id`, `userId`, `platform`, `deviceName?`, `pushToken?`,
  `lastSeenAt?` — deja lista la base para notificaciones push futuras ("se actualizó
  el ranking") y para saber desde qué dispositivo se tomó cada decisión.
- **`UserDecision`** y **`HipObservation`** viven en el servidor, asociadas a un
  usuario, una organización y un Hip — esto es lo que permite que abras la app en
  el iPad, anotes algo, y lo veas en el iPhone.
- **`AnalysisResult`**: cada análisis queda como fila nueva (historial completo),
  scopeada por `organizationId` (ver 1a). `CurrentHipAnalysis` guarda el puntero al
  análisis vigente de cada Hip+organización para que las consultas sigan siendo
  rápidas.
- **`RankingSnapshotVersion`**: una fila nueva cada vez que se recalcula el ranking
  de una jornada de una organización — permite mostrar más adelante "cómo cambió el
  top 20 a lo largo del día".

## 1a. Multi-tenant (`Organization`)

Hoy RM Selection lo usa un solo equipo, compartiendo la misma evaluación. La
arquitectura ya está preparada para evolucionar a una plataforma con múltiples
compradores, cada uno con su cuenta, datos privados y decisiones separadas — sin
rediseñar nada, solo dando de alta más filas de `Organization`.

Decisión de diseño clave: **`Sale` y `Hip` (el catálogo) quedan GLOBALES**, sin
`organizationId`. Son datos públicos que publica cada casa de ventas — nombre,
consignatario, fotos — iguales para cualquier organización que los mire. Si se
scopearan por organización, cada organización nueva dispararía un scraping
duplicado del mismo catálogo público (más costo, más carga sobre las casas de
ventas, sin ningún beneficio).

Lo que SÍ varía por organización es la **evaluación** de ese catálogo, porque cada
organización puede tener su propio caballo referente y por lo tanto llegar a un
puntaje distinto sobre exactamente las mismas fotos. Por eso quedan scopeados por
`organizationId`: `AnalysisResult`, `CurrentHipAnalysis`, `RankingSnapshot`,
`RankingSnapshotVersion`, `ReferenceHorse`, `User` (y, denormalizado, `UserDecision`
y `HipObservation`).

El puntero "análisis vigente de este Hip" pasó de ser un campo único en `Hip`
(`currentAnalysisId`, solo podía apuntar a UNO en total) a una tabla
`CurrentHipAnalysis(hipId, organizationId) → analysisResultId`: bajo multi-tenant,
un mismo Hip puede tener un análisis vigente distinto por organización.

El scheduler (`scheduler.ts` → `rankingService.processSale`) sincroniza el
catálogo de cada venta UNA sola vez (es global), y después recorre organización ×
venta para analizar/rankear — a esta escala (una organización) es un doble loop
simple; el día que haya muchas organizaciones activas, conviene agregar una tabla
de "qué organización sigue qué venta" para no recorrerlas todas sin necesidad.

## 1b. Descubrimiento automático de ventas nuevas

El backend ya no depende de que alguien dé de alta cada venta a mano: un cron
separado (`startDiscoveryScheduler`, cada 6h por defecto —
`DISCOVERY_INTERVAL_CRON`) lee las páginas PÚBLICAS de anuncios/calendario de
Fasig-Tipton, Keeneland y OBS (`src/saleHouses/discovery/*.ts`), filtra solo
lo que todavía es futuro, y da de alta sola cualquier venta nueva —
generando además una fila en `SaleAlert` (feed de "novedades", `GET
/api/v1/alerts`) para que la app avise al usuario.

Las tres casas de ventas NO tienen el mismo nivel de acceso automático, y
`Sale.catalogAccess` lo refleja explícitamente en vez de fingir que las tres
son iguales:

- **Keeneland → `FULL`**: su página `/sales/all-sales/` ya lista solo ventas
  futuras, con URLs que traen año + ID interno + slug — los mismos tres
  datos que ya usan la API de catálogo y el scraper de "Schedule of Sale"
  (`keenelandSchedule.ts`). Se detecta, se da de alta y arranca a
  sincronizarse sola, sin ningún paso manual.
- **Fasig-Tipton → `PENDING_ID`**: su página pública de catálogos
  (`/catalogues/{año}`) confirma nombre y fechas, pero el ID numérico interno
  que pide su API de catálogo (`django/api/horses/?sale={id}`) NO aparece en
  ninguna página pública — la pestaña "Catalogue" de cada venta lo carga vía
  JavaScript del lado del cliente. Adivinar ese ID por fuerza bruta
  (probar números secuenciales) NO es un método de acceso autorizado y
  podría exponer catálogos de ventas ajenos — por eso no se implementa. La
  venta se detecta, se alerta y se crea igual, pero el scheduler de análisis
  la salta (`processSale` corta temprano si `catalogAccess !== "FULL"`)
  hasta que alguien complete el ID real vía `POST /sales` (se consigue una
  vez, a mano, inspeccionando la pestaña "Bid Online" / Client Portal).
- **OBS → `UNAVAILABLE`**: no existe ninguna API de catálogo conocida
  (su plataforma de pujas vive en dominios separados —
  `bid.obssales.com`/`obsonline.com` — sin documentación pública de acceso
  programático). Lo único que se puede detectar hoy es el ANUNCIO de la
  venta, leyendo el feed RSS estándar de su blog (`obssales.com/feed/`,
  filtrando posts con palabras clave de venta/catálogo + un año) — un feed
  RSS es, por diseño, un mecanismo pensado para consumo automático, la
  opción más respetuosa disponible. La venta se crea y se alerta igual que
  las otras dos, pero queda permanentemente sin sincronizar hasta que OBS
  publique un método de acceso autorizado y se construya un
  `SaleHouseClient` real (hoy `src/saleHouses/obs.ts` sigue siendo un stub
  que tira error a propósito en vez de inventar datos).

Todos los scrapers de descubrimiento respetan `robots.txt` de cada sitio
(verificado: ninguna de las páginas que se leen está bajo una ruta
prohibida) y usan únicamente páginas/feeds pensados para lectura pública.

Notificación al usuario: por ahora la vía es un feed dentro de la propia
app (`GET /api/v1/alerts`, pantalla "Novedades" en iOS con contador de no
leídas) — no hay notificaciones push (APNs) todavía. Implementarlas
requiere que el usuario cree/tenga una cuenta de Apple Developer Program y
genere una clave de push (no se puede crear en su nombre), además de que la
app pida permiso de notificaciones. El esquema ya deja `Device.pushToken`
listo para ese paso — ver sección 6.

## 2. Autenticación

`x-api-key` identifica a un `User` real, que pertenece a una `Organization` (se
siembra un único usuario "dueño" en una única organización con la clave que ya
tenés — ver `prisma/seed.ts`). Cada decisión/observación/análisis que se guarda
queda asociado a un usuario y a su organización. Login real (email/contraseña o
link mágico) queda documentado para el día que haga falta que compradores
distintos se registren solos — no se construye antes de que haga falta.

## 3. Sincronización entre dispositivos

El servidor pasa a ser la fuente de verdad de decisiones/observaciones; SwiftData
en el dispositivo queda como caché local. Resolución de conflictos: el más
reciente gana (por `updatedAt`) — suficiente para el patrón de uso real (un
comprador, normalmente un dispositivo activo a la vez durante la subasta); no vale
la pena construir fusión más fina hasta que haga falta de verdad.

**Importante**: esto requiere un cambio del lado de iOS (hoy decisiones/observaciones
viven embebidas como JSON dentro de `HipRecord`, no como entidades propias) — se
deja como proyecto separado, después de que el backend esté estable en producción,
no bloquea el deploy a Railway.

## 4. Escalabilidad y robustez del scheduler

El diseño actual (cron en el mismo proceso que la API) alcanza de sobra para 1-2
organizaciones y unas pocas ventas por año. El riesgo real a futuro: si el servicio
se escala a más de una réplica, cada réplica correría su propio scheduler y
duplicaría el análisis. Solución simple cuando haga falta: separar el scheduler a
un segundo servicio Railway (sin colas ni Redis todavía). Una cola de verdad
(BullMQ + Redis) se documenta como próximo paso, no se construye ahora.

Ya implementado, para que el proceso único sea confiable en producción:

- **Sin ciclos superpuestos**: si un ciclo tarda más que el intervalo del próximo
  tick (posible en jornada de venta, tick cada 5 min), el siguiente tick se salta
  en vez de correr en paralelo contra las mismas filas.
- **Transacciones**: cada análisis nuevo + actualización del puntero
  `CurrentHipAnalysis` va en una transacción — no puede quedar un `AnalysisResult`
  nuevo con el puntero todavía apuntando al viejo si el proceso se corta a mitad de
  camino.
- **Presupuesto de análisis por ciclo** (`MAX_ANALYSES_PER_CYCLE`, default 50):
  protección de costo si un bug hiciera que muchos Hips parecieran "cambiados" a la
  vez. Lo que no entra en un ciclo se retoma en el siguiente, no se pierde.
- **`SchedulerRun`**: registro de cada ciclo (cuándo corrió, cuántas ventas
  procesó, si hubo error) — útil para diagnosticar sin depender de los logs de
  Railway, que rotan.
- **Apagado prolijo**: Railway manda `SIGTERM` antes de matar el contenedor en cada
  redeploy; el servidor cierra la conexión HTTP y Postgres de forma ordenada en vez
  de cortar de golpe un análisis a mitad de camino.

## 5. Versionado de API y extensibilidad

- La API pasa a montarse en `/api/v1` (casi gratis ahora, evita romper un cliente
  viejo de iOS más adelante).
- Nuevas casas de venta: mismo contrato `SaleHouseClient` que ya existe.
- Nuevos criterios de análisis: `conformationScoresJson` ya es flexible (JSON), no
  hace falta migración para agregar subcategorías.
- Notificaciones push: la columna `Device.pushToken` queda lista; la integración con
  APNs se construye después.

## 6. Qué se construye ahora vs. qué queda documentado para después

**Ahora** (barato hoy, caro después): todo el punto 1 y 1a (User, Device,
Organization/multi-tenant, UserDecision, HipObservation, historial de
AnalysisResult scopeado por organización, CurrentHipAnalysis,
RankingSnapshotVersion), el cambio de autenticación a nivel User+Organization,
mover la API a `/api/v1`, toda la robustez del scheduler (punto 4), y el
descubrimiento automático de ventas nuevas (punto 1b).

**Después** (documentado, no construido): login real multiusuario (registro propio
por organización, no solo el owner sembrado a mano), notificaciones push
(integración APNs), cola de trabajos (BullMQ/Redis), dashboard de administración,
fusión de conflictos más fina que "el más reciente gana", filtrado de "qué
organización sigue qué venta" (necesario solo cuando haya muchas organizaciones),
copiar media de las casas de venta a almacenamiento propio (Cloudflare R2 o S3), y
el trabajo del lado de iOS para romper decisiones/observaciones en entidades
propias sincronizables.

**Decisión tomada sobre el storage de media**: por ahora el backend guarda
únicamente las URLs originales que publica cada casa de ventas (`Hip.mediaJson`),
sin copiar nada a almacenamiento propio. Riesgo aceptado: si una casa de ventas
rota o da de baja una URL después de la venta, se pierde el acceso a esa foto/video
puntual (el puntaje ya calculado en `AnalysisResult` NO se pierde, solo la imagen
para volver a verla). Esto queda preparado para activarse más adelante sin
rediseño: `mediaJson` ya es JSON flexible, así que el día que se sume
almacenamiento propio alcanza con agregar un campo (`storedUrl` o similar) a cada
item de ese JSON durante la descarga/análisis, sin migración de esquema. Requiere
que el usuario cree la cuenta de Cloudflare R2/S3 primero (no se puede crear en su
nombre) y revisar costos y condiciones de uso de cada casa de ventas antes de
activarlo.
