# RM Selection — backend del Ranking del Día

Este servicio reemplaza el análisis "on-device" que hacía la app de iOS.
Corre 24/7 en Railway, se encarga de:

- Descargar automáticamente el catálogo de cada venta: Fasig-Tipton y Keeneland vía API en vivo; OBS (sin API pública) vía carga manual de CSV que entra por el mismo pipeline — ver `ARCHITECTURE.md` §1c y §6b más abajo.
- Resolver sola la fecha de sesión de cada Hip (directo del catálogo en Fasig-Tipton; leyendo el "Schedule of Sale" público en Keeneland).
- Chequear cada venta a distinta frecuencia según qué tan cerca esté la próxima jornada (cada 12h si falta un mes, hasta cada 5 min con la jornada en curso — ver `src/saleHouses/pollingPolicy.ts`).
- Generar el Ranking del Día automáticamente 12 horas antes de cada jornada, y reanalizar solo los Hips cuya foto/video cambió desde el último análisis.
- Guardar el resultado en Postgres, listo para que la app lo lea sin esperar nada.

La app de iOS solo hace `GET` a este servicio — nunca vuelve a llamar a la IA por su cuenta.

## 1. Crear el proyecto en Railway

1. Entrá a [railway.app](https://railway.app) y creá una cuenta (podés usar tu GitHub).
2. "New Project" → "Deploy from GitHub repo". Si este código todavía no está en un repo de GitHub, subilo primero (`git init`, `git add .`, `git commit`, y pusheá un repo nuevo con SOLO la carpeta `backend/` como raíz, o indicále a Railway que la raíz del servicio es `backend/` si subís todo el repo de RMSelection junto).
3. Railway va a detectar que es un proyecto Node y va a usar Nixpacks solo (ya incluí `railway.json` con la configuración de build/start).

## 2. Agregar Postgres

1. Dentro del proyecto en Railway: "New" → "Database" → "Add PostgreSQL".
2. Railway conecta automáticamente la variable `DATABASE_URL` al servicio — no hace falta copiarla a mano si el servicio y la base están en el mismo proyecto Railway.

## 3. Variables de entorno

En el servicio del backend → pestaña "Variables", cargá:

| Variable | Valor |
|---|---|
| `ANTHROPIC_API_KEY` | Tu API key de Anthropic (la misma que usabas en la app) |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` (o dejalo vacío para usar ese valor por defecto) |
| `APP_API_KEY` | Inventá un string largo al azar — es la clave que la app de iOS va a mandar para poder consultarte la API. Guardala, la vas a necesitar en el próximo paso del lado de la app. |
| `RANKING_LEAD_HOURS` | `12` |
| `TOP_RANKING_SIZE` | `20` |
| `DISCOVERY_INTERVAL_CRON` | Opcional — cada cuánto se chequean las páginas públicas de anuncios de Fasig-Tipton/Keeneland/OBS en busca de ventas nuevas. Por defecto `0 */6 * * *` (cada 6 horas) — no hace falta tocarlo. |

`DATABASE_URL` y `PORT` los pone Railway solo, no hace falta cargarlos.

## 4. Deploy

Con el repo conectado, Railway hace deploy automático en cada push. La primera vez:

1. Esperá a que termine el build (corre `prisma generate` + `tsc`).
2. El primer arranque corre `prisma migrate deploy` solo (está en el script `start`) — pero como todavía no existe ninguna migración generada, hay que crearla una vez desde tu máquina antes del primer deploy:
   ```bash
   cd backend
   npm install
   npx prisma migrate dev --name init
   git add prisma/migrations
   git commit -m "Primera migración"
   git push
   ```
3. Confirmá que el servicio levantó: `https://<tu-servicio>.up.railway.app/health` debería devolver `{"ok":true,...}`.

## 5. Sembrar la organización y el usuario dueño

La `APP_API_KEY` que cargaste en el paso 3 ahora identifica a un usuario real
dentro de una organización (ver `ARCHITECTURE.md` §1a y §2), no es solo un
secreto suelto — esto es lo que permite que decisiones/observaciones/análisis
que se guarden más adelante queden asociados a alguien y puedan sincronizar
entre tus dispositivos. El seed crea una única `Organization` ("RM Selection")
y te agrega ahí como dueño — el día que sumes compradores independientes con
cuentas separadas, se dan de alta como organizaciones nuevas, sin tocar el
esquema. Corré esto una vez, desde tu máquina, apuntando a la base de Railway
(Railway te deja copiar el `DATABASE_URL` público desde la pestaña del plugin
de Postgres):

```bash
cd backend
DATABASE_URL="<el de Railway>" APP_API_KEY="<el mismo que cargaste en Variables>" npm run db:seed
```

## 6. Dar de alta las ventas

Con el servicio ya corriendo, das de alta cada venta activa vía la API (una sola vez por edición de venta — esto no se puede auto-descubrir, cada casa de ventas "abre" una venta nueva cuando quiere):

```bash
curl -X POST https://<tu-servicio>.up.railway.app/api/v1/sales \
  -H "x-api-key: TU_APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "house": "FASIG_TIPTON",
    "name": "Fasig-Tipton — Saratoga",
    "externalSaleId": "309"
  }'
```

Para Keeneland, agregá también `scheduleYear` y `scheduleSlug` (los datos de la URL de su página "Deadlines and Schedule", ej. `https://www.keeneland.com/sales/2025/2/september-yearling-sale/about/` → `scheduleYear: 2025`, `scheduleSlug: "september-yearling-sale"`, `externalSaleId: "2"`):

```bash
curl -X POST https://<tu-servicio>.up.railway.app/api/v1/sales \
  -H "x-api-key: TU_APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "house": "KEENELAND",
    "name": "Keeneland — September Yearling Sale",
    "externalSaleId": "2",
    "scheduleYear": 2026,
    "scheduleSlug": "september-yearling-sale"
  }'
```

## 6b. Cargar el catálogo a mano (OBS y cualquier venta sin API pública)

OBS no tiene ninguna API de catálogo pública (se investigó a fondo — ver
`ARCHITECTURE.md` §1c), así que sus ventas quedan `catalogAccess: MANUAL_CSV`
en vez de sincronizarse solas. Para que RM Selection empiece a analizarlas,
subí el CSV/export del catálogo (el mismo que ya te manda o publica la casa
de ventas a consignatarios/compradores) una vez que esté disponible:

```bash
curl -X POST https://<tu-servicio>.up.railway.app/api/v1/sales/<SALE_ID>/catalog/import \
  -H "x-api-key: TU_APP_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @- <<EOF
{
  "fileName": "obs-october-2026.csv",
  "csv": "Hip Number,Horse Name,Sex,Sire,Dam,Dam Sire,Consignor,Foal Year,Color,Session Date,Photo URL,Walking Video,UT Video\n1,,C,Into Mischief,Some Mare,Some Sire,Consignor Farm,2024,Bay,2026-10-06,https://.../foto1.jpg,https://.../walk1.mp4,https://.../ut1.mp4\n"
}
EOF
```

`<SALE_ID>` es el `id` interno que devuelve `GET /sales` (no el
`externalSaleId`). Solo la columna "Hip Number" es obligatoria — el resto se
usa si está presente, y las columnas de foto/video se pueden repetir tantas
veces como haga falta ("Photo URL", "Photo URL 2", etc.) — ver
`ARCHITECTURE.md` §1c para el formato completo y `GET
/sales/<SALE_ID>/catalog/imports` para ver el historial de cargas. Cada
import que subís reemplaza/actualiza los Hips por número de Hip — podés
volver a subir el mismo archivo actualizado (ej. con fotos que se agregaron
después) tantas veces como haga falta antes de la subasta; RM Selection
detecta sola qué Hips tienen media nueva y solo reanaliza esos.

Este mismo endpoint funciona para CUALQUIER venta (incluidas Fasig-Tipton o
Keeneland) si en algún momento querés adelantar/corregir un dato a mano sin
esperar al próximo chequeo automático.

## 7. Cargar el caballo referente

El análisis necesita las fotos del patrón oficial del Método RM. Subí esas fotos a cualquier hosting (podés usar el mismo Railway con un bucket, o simplemente URLs públicas ya existentes) y cargalas — esto queda asociado a TU organización (la que sembraste en el paso 5), así que necesita el mismo `x-api-key`:

```bash
curl -X PUT https://<tu-servicio>.up.railway.app/api/v1/reference-horse \
  -H "x-api-key: TU_APP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "photoUrls": ["https://.../foto1.jpg", "https://.../foto2.jpg"],
    "gaitVideoUrl": "https://.../marcha.mp4"
  }'
```

## 8. Conectar la app de iOS

En Xcode, la URL base del backend y la `APP_API_KEY` se configuran en... (ver cambios en `RMSelection/Services/RankingBackendClient.swift` — se pueden dejar hardcodeadas ahí, o mover a un `.xcconfig` si preferís no tener la URL en el código fuente).

## Notas de arquitectura

- **Un solo servicio** corre tanto la API (Express) como el scheduler (`node-cron`, tick cada 5 minutos) — no hace falta un worker aparte para esta escala.
- **Frecuencia de chequeo variable** (`src/saleHouses/pollingPolicy.ts`): 30-15 días antes cada 12h, 15-7 días cada 6h, 7 días-24h cada 1h, últimas 24h cada 15 min, jornada en curso cada 5 min.
- **Detección de cambios**: cada Hip guarda un hash (`analyzedMediaHash`) del último set de fotos/video que se analizó. Si el hash actual no coincide, se reanaliza SOLO ese Hip — nunca hace falta reanalizar toda la venta de nuevo.
- **Video de Vimeo**: se resuelve la URL progresiva (mp4 directo) desde el endpoint público de configuración del reproductor (`player.vimeo.com/video/{id}/config`), sin necesitar token — más simple y confiable que el enfoque anterior en iOS (que necesitaba abrir un WebView oculto). Si un video no es embebible públicamente, el análisis sigue solo con fotos fijas (igual que antes).
- **OBS**: sin API pública de catálogo (investigado a fondo — ver `ARCHITECTURE.md` §1c: su catálogo real vive en `obscatalog.com` pero se renderiza 100% vía JavaScript del lado del cliente, sin ningún endpoint público identificable). En vez de quedar sin sincronizar para siempre, sus ventas quedan `catalogAccess: MANUAL_CSV` — se detectan y alertan solas (RSS de `obssales.com`), y el catálogo se carga a mano vía `POST /sales/:saleId/catalog/import` (ver §6b más arriba); a partir de ahí, análisis y Ranking del Día funcionan exactamente igual que para Keeneland o Fasig-Tipton. `src/saleHouses/obs.ts` (integración por API en vivo) sigue siendo un stub, listo para completarse el día que OBS publique un método de acceso automático.
- **Historial, usuarios y sincronización**: ver `ARCHITECTURE.md` para el diseño completo. En resumen: `AnalysisResult` ya no se sobrescribe (queda historial completo de cada reanálisis), cada recálculo del ranking queda registrado en `RankingSnapshotVersion`, y ya existen las rutas `/api/v1/me/decisions` y `/api/v1/me/observations` para que las decisiones y observaciones del usuario sincronicen entre el iPad y el iPhone — la app de iOS todavía no las llama (siguen viviendo en SwiftData local por ahora), eso queda como un proyecto aparte una vez que el backend esté funcionando en producción.
- **Multi-tenant (`Organization`)**: hoy toda tu key seedeada cae en una sola organización compartida (ver paso 5). El esquema ya soporta dar de alta compradores independientes con datos, decisiones y caballo referente completamente separados, sin ninguna migración — ver `ARCHITECTURE.md` §1a. El catálogo (`Sale`/`Hip`) es lo único que queda global entre organizaciones, para no duplicar scraping del mismo catálogo público.
- **Descubrimiento automático de ventas**: ya no hace falta dar de alta cada venta a mano (paso 6) — un cron aparte revisa cada 6h las páginas públicas de anuncios de Fasig-Tipton, Keeneland y OBS y las crea solo, avisando por `GET /api/v1/alerts` (la app lo muestra en la pantalla "Novedades", con campanita y contador). Igual podés seguir dando de alta ventas a mano con el paso 6 — por ejemplo, para completar el ID real de catálogo de una venta de Fasig-Tipton que quedó detectada pero sin sincronizar (ver `ARCHITECTURE.md` §1b para el detalle de qué puede y no puede automatizarse en cada casa de ventas).
- **Robustez del scheduler**: los ciclos no se superponen (si uno tarda más que el intervalo del próximo tick, ese tick se salta en vez de correr en paralelo), cada análisis+actualización del puntero vigente va en una transacción (no puede quedar a mitad de camino si Railway reinicia el contenedor), hay un tope de cuántos Hips se analizan por ciclo (`MAX_ANALYSES_PER_CYCLE`, protección de costo), y `SchedulerRun` deja un registro de cada ciclo (cuándo corrió, cuántas ventas procesó, si hubo error) — útil para diagnosticar algo que pasó de madrugada sin depender de los logs de Railway, que rotan.
