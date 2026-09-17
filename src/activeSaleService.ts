import { db } from "./db";
import type { Sale } from "@prisma/client";

/**
 * VENTA ÚNICA "ACTIVA PARA AUTOMATIZACIÓN" (2026-09-17, a pedido explícito
 * de Ramon: "BARRIDO AUTOMÁTICO DE MEDIA SOLO PARA LA VENTA ACTIVA" — no
 * quiere que el job nocturno de las 3am recorra todas las ventas
 * cargadas, solo la que corresponda por fecha en cada momento).
 *
 * 100% CALCULADO en cada llamada, a partir de Sale.startDate/endDate —
 * a propósito NUNCA depende de ninguna bandera persistida que alguien
 * tenga que acordarse de apagar a mano. Cita textual del pedido: "no
 * quiero que dos o más ventas antiguas sigan siendo procesadas
 * simplemente porque alguna bandera anterior quedó activa". Por esto
 * mismo, un redeploy/restart/recovery (ver scheduler.ts,
 * catchUpMissedNightlySyncIfNeeded) es seguro sin ningún caso especial:
 * cualquiera sea el motivo por el que se dispara el job nocturno, siempre
 * vuelve a calcular la venta activa desde cero, en vez de asumir un
 * estado guardado que puede haber quedado desactualizado.
 *
 * CANDIDATAS: `isActive=true` (la venta sigue dada de alta normalmente,
 * visible en GET /sales — una venta archivada a mano con isActive=false,
 * ver comentario en routes.ts sobre altas duplicadas, nunca puede ser la
 * activa) y `catalogAccess=FULL` con `startDate` ya resuelto (las únicas
 * con una API de catálogo en vivo real contra la que barrear Media —
 * MANUAL_CSV/PENDING_ID/UNAVAILABLE no tienen ningún camino automático
 * legítimo, mismo criterio que ya usa mediaSweepService.ts).
 *
 * CRITERIO DE SELECCIÓN: entre las candidatas, se elige la de MENOR
 * distancia temporal entre "ahora" y su propio rango [startDate, endDate]
 * (`endDate` ausente = venta de un solo día, usa `startDate` como su
 * propio fin — mismo criterio que ya usa GET /sales para el cliente):
 *   - "ahora" DENTRO de [startDate, endDate] → distancia CERO — la venta
 *     está genuinamente en curso, gana siempre que exista una así.
 *   - "ahora" ANTES de startDate → distancia = startDate - ahora — venta
 *     futura, cuanto más próxima más prioridad.
 *   - "ahora" DESPUÉS de endDate → distancia = ahora - endDate — venta ya
 *     terminada, cuanto más reciente más prioridad, pero SIEMPRE pierde
 *     contra cualquier venta en curso o futura más próxima.
 * Este único número resuelve solo, sin reglas especiales para cada caso,
 * exactamente lo que pidió Ramon: mientras Keeneland September Yearling
 * Sale 2026 esté en curso (14–26 sept), gana con distancia cero; el día
 * que termine, la distancia de Keeneland empieza a crecer mientras la de
 * la próxima venta (California Fall Yearlings, 30 sept) empieza a bajar —
 * el cruce pasa solo, sin tocar ninguna bandera a mano; y una venta de
 * hace meses (ej. Fasig-Tipton — Saratoga, agosto) queda con una
 * distancia enorme, nunca vuelve a competir por accidente.
 *
 * Empate exacto en distancia (dos ventas realmente en curso al mismo
 * tiempo, caso raro pero posible entre casas distintas) se desempata de
 * forma determinística por `startDate` ascendente (la que arrancó
 * primero) — nunca por orden arbitrario de la base de datos.
 *
 * `null` = no hay ninguna venta candidata (ninguna isActive+FULL con
 * startDate resuelto) — el llamador debe tratarlo como "no hay nada que
 * barrer en esta corrida", nunca como error.
 */
export async function resolveActiveSaleForAutomation(): Promise<Sale | null> {
  const candidates = await db.sale.findMany({
    where: { isActive: true, catalogAccess: "FULL", startDate: { not: null } },
    orderBy: { startDate: "asc" },
  });
  if (candidates.length === 0) return null;

  const now = Date.now();
  let best: Sale | null = null;
  let bestDistance = Infinity;
  for (const sale of candidates) {
    const start = sale.startDate!.getTime();
    const end = (sale.endDate ?? sale.startDate!).getTime();
    let distance: number;
    if (now < start) distance = start - now;
    else if (now > end) distance = now - end;
    else distance = 0;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sale;
    }
  }
  return best;
}
