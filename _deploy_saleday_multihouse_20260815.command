#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "=== Limpiando lock de git residual (si existe) ==="
rm -f .git/index.lock
echo "=== git status ==="
git status --short
echo "=== git add ==="
git add src/rankingService.ts src/saleHouses/fasigTipton.ts src/saleHouses/obs.ts src/saleHouses/sessionDateSaleDays.ts
echo "=== git commit ==="
git commit -m "Calendario de Ventas: generalizar SaleDay a Fasig-Tipton y OBS (2026-08-15)

A pedido de Ramon: 'Implementar el Calendario de Ventas tambien para
Fasig-Tipton y OBS, utilizando exactamente el mismo funcionamiento,
diseno y ubicacion que ya esta implementado para Keeneland.'

La arquitectura de SaleDay/resolveSaleDays/syncSaleDays ya era generica
por casa desde la tarea de Keeneland (schema, tipos, scheduler con
reintento automatico) -- lo unico que faltaba era que Fasig-Tipton y
OBS implementaran el metodo opcional resolveSaleDays() de SaleHouseClient.

(1) Nuevo helper compartido src/saleHouses/sessionDateSaleDays.ts:
resolveSaleDaysFromSessionDates() agrupa un Map hipNumber->fecha (la
misma salida que ya produce resolveSessionDates() de cualquier casa)
en filas ResolvedSaleDay, calculando rango de Hip y headcount por dia
-- sin inventar book/session/hora, que ninguna de las dos casas expone.

(2) FasigTiptonClient.resolveSaleDays(): usa el campo real 'session' que
ya trae cada Hip del catalogo (el mismo que resolveSessionDates ya
consume) -- funciona con datos reales desde ya para cualquier venta
Fasig-Tipton con ID de API real (ej. la Saratoga Sale ya registrada).

(3) OBSClient.resolveSaleDays(): mismo patron, hoy no-op seguro (OBS no
tiene todavia integracion real de catalogo) -- el dia que la tenga, el
calendario empieza a funcionar solo, sin tocar nada mas.

(4) rankingService.ts: se detecto que la venta Fasig-Tipton 'New York
Bred Yearlings' esta registrada como MANUAL_CSV (no tiene ID real de
API, se cargo por CSV) -- el camino anterior de syncSaleDays (que
depende de un SaleHouseClient con ID real) nunca la habria cubierto.
Se agrego syncSaleDaysFromStoredHips(), que arma el calendario con el
mismo helper pero leyendo Hip.sessionDate ya persistido en la base
(poblado por el propio CSV si trae columna Session Date) en vez de
llamar a ninguna API -- mismo principio de nunca inventar datos, cubre
tambien el camino real de OBS (que segun manualCatalogImport.ts es
MANUAL_CSV, no una API en vivo). processSale() ahora dispara este
camino para catalogAccess MANUAL_CSV igual que ya hacia para FULL,
mismo gating de 'solo si todavia no tiene SaleDay' y mismo reintento
automatico en cada ciclo del scheduler -- una sola estructura de datos,
sin tres calendarios independientes.

No se toco Keeneland (sigue con su propio resolveSaleDays via PDF de
Hip Grouping), ni el modelo SaleDay, ni ninguna decision del Metodo RM.
No se requieren cambios de iOS: SaleCalendarView.swift ya es generico
por casa (house/externalSaleId), confirmado por lectura de codigo."
echo "=== git push ==="
git push origin main
echo "=== DONE ==="
