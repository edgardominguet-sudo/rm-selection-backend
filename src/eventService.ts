import { Sale } from "@prisma/client";
import { db } from "./db";
import { reentryIndex, ReentryMatch } from "./reentryService";
import { normalizeHistoryResult } from "./saleHistoryService";

/**
 * Centro de Avisos (2026-10-04, pedido de Ramon). Los avisos los genera el
 * servidor en el momento en que pasa cada cosa:
 *   - OUT        HIPs retirados antes / durante la venta (refresco de resultados)
 *   - NEW_SALE   catálogo de una venta nueva publicado e importado
 *   - REENTRY    un caballo con decisión guardada o análisis aparece
 *                inscrito en una venta posterior
 * `dedupeKey` (único) garantiza que cada aviso se cree una sola vez.
 */

type EventInput = {
  kind: "OUT" | "NEW_SALE" | "REENTRY";
  title: string;
  body: string;
  dedupeKey: string;
  house?: string | null;
  externalSaleId?: string | null;
  hipNumber?: string | null;
  targetHouse?: string | null;
  targetExternalSaleId?: string | null;
  targetHipNumber?: string | null;
  hips?: string[] | null;
  important?: boolean;
};

async function createEvent(input: EventInput): Promise<boolean> {
  const exists = await db.appEvent.findUnique({ where: { dedupeKey: input.dedupeKey }, select: { id: true } });
  if (exists) return false;
  try {
    await db.appEvent.create({
      data: {
        kind: input.kind,
        title: input.title.slice(0, 300),
        body: input.body.slice(0, 2000),
        dedupeKey: input.dedupeKey.slice(0, 500),
        house: input.house ?? null,
        externalSaleId: input.externalSaleId ?? null,
        hipNumber: input.hipNumber ?? null,
        targetHouse: input.targetHouse ?? null,
        targetExternalSaleId: input.targetExternalSaleId ?? null,
        targetHipNumber: input.targetHipNumber ?? null,
        hips: input.hips ? (input.hips as unknown as object) : undefined,
        important: input.important ?? false,
      },
    });
    return true;
  } catch {
    return false; // carrera con otro proceso: el aviso ya existe
  }
}

function houseLabel(house: string): string {
  if (house === "FASIG_TIPTON") return "Fasig-Tipton";
  if (house === "KEENELAND") return "Keeneland";
  return "OBS";
}

/** "OBS October", "Fasig-Tipton Kentucky October Yearlings"… */
export function shortSaleName(name: string, house: string): string {
  let n = name
    .replace(/Catalog Now Available Online/gi, "")
    .replace(/\b20\d{2}\b/g, "")
    .replace(/\bYearling Sale\b/gi, "")
    .replace(/\s+Sale$/i, "")
    .replace(/^(OBS|Fasig-Tipton|Keeneland)\s*[—-]?\s*/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!n) n = name;
  return `${houseLabel(house)} ${n}`.trim();
}

function money(value: number | null): string | null {
  if (value == null || !(value > 0)) return null;
  return "$" + Math.round(value).toLocaleString("en-US");
}

function resultText(json: unknown): string | null {
  const r = json as { priceRaw?: string | null; purchaser?: string | null; soldAsCode?: string | null } | null;
  if (!r) return null;
  const n = normalizeHistoryResult(r.priceRaw ?? null, r.purchaser ?? null, r.soldAsCode ?? null);
  switch (n.status) {
    case "SOLD":
    case "PS":
      return ["Vendido", money(n.amount)].filter(Boolean).join(" ");
    case "RNA":
      return ["RNA", money(n.amount)].filter(Boolean).join(" ");
    case "OUT":
      return "OUT";
    default:
      return null;
  }
}

function dayLabel(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "America/New_York" });
}

/** Aviso de HIPs que pasaron a OUT en esta pasada (uno por venta y tanda). */
export async function recordOutEvent(sale: Sale, hipNumbers: string[]): Promise<void> {
  if (hipNumbers.length === 0) return;
  const sorted = [...new Set(hipNumbers)].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const watched = await db.hip.findMany({
    where: {
      saleId: sale.id,
      hipNumber: { in: sorted },
      OR: [{ decisions: { some: { deletedAt: null } } }, { currentAnalyses: { some: {} } }],
    },
    select: { hipNumber: true },
  });
  const watchedNumbers = watched.map((h) => h.hipNumber);
  const name = shortSaleName(sale.name, sale.house);
  const title = `${name}: ${sorted.length} HIP${sorted.length === 1 ? "" : "s"} retirado${sorted.length === 1 ? "" : "s"} (OUT)`;
  let body = `HIP ${sorted.join(", ")}`;
  if (watchedNumbers.length) body += `. Entre ellos tus marcados: HIP ${watchedNumbers.join(", ")}`;
  await createEvent({
    kind: "OUT",
    title,
    body,
    dedupeKey: `OUT:${sale.id}:${sorted.join(",")}`,
    house: sale.house,
    externalSaleId: sale.externalSaleId,
    hipNumber: sorted.length === 1 ? sorted[0] : null,
    hips: sorted,
    important: watchedNumbers.length > 0,
  });
}

/** Aviso de catálogo nuevo importado (una sola vez por venta). */
export async function recordNewSaleEvent(sale: Sale, hipCount: number): Promise<void> {
  if (hipCount <= 0) return;
  const when = sale.startDate ? ` · ${dayLabel(sale.startDate.toISOString())}` : "";
  await createEvent({
    kind: "NEW_SALE",
    title: `Nueva venta publicada: ${shortSaleName(sale.name, sale.house)}`,
    body: `${hipCount} HIPs en el catálogo${when}.`,
    dedupeKey: `NEW_SALE:${sale.id}`,
    house: sale.house,
    externalSaleId: sale.externalSaleId,
  });
}

/**
 * Reinscritos: caballos con decisión guardada o análisis que aparecen en
 * una venta posterior todavía sin resultado. Idempotente (dedupeKey por
 * caballo + venta de destino), barato (solo los HIPs marcados).
 */
export async function generateReentryEvents(onlyHipIds?: string[]): Promise<number> {
  const watched = await db.hip.findMany({
    where: {
      ...(onlyHipIds ? { id: { in: onlyHipIds } } : {}),
      OR: [{ decisions: { some: { deletedAt: null } } }, { currentAnalyses: { some: {} } }],
    },
    select: { id: true, hipNumber: true, saleResultJson: true, sale: true },
  });
  let created = 0;
  const bySale = new Map<string, typeof watched>();
  for (const h of watched) {
    const list = bySale.get(h.sale.id);
    if (list) list.push(h); else bySale.set(h.sale.id, [h]);
  }
  for (const [saleId, hips] of bySale) {
    const index = await reentryIndex(saleId);
    for (const h of hips) {
      const matches: ReentryMatch[] = (index[h.hipNumber] ?? []).filter((m) => m.status == null);
      for (const m of matches) {
        const from = shortSaleName(h.sale.name, h.sale.house);
        const to = shortSaleName(m.saleName, m.house);
        const prev = resultText(h.saleResultJson);
        const when = m.saleDate ? ` · ${dayLabel(m.saleDate)}` : "";
        const ok = await createEvent({
          kind: "REENTRY",
          title: `Reinscrito: HIP ${h.hipNumber} de ${from}`,
          body: `${prev ? `${prev} en ${from} → ` : ""}inscrito en ${to} · HIP ${m.hipNumber}${when}${m.confidence === "LIKELY" ? " (probable)" : ""}`,
          dedupeKey: `REENTRY:${h.id}->${m.house}:${m.externalSaleId}:${m.hipNumber}`,
          house: h.sale.house,
          externalSaleId: h.sale.externalSaleId,
          hipNumber: h.hipNumber,
          targetHouse: m.house,
          targetExternalSaleId: m.externalSaleId,
          targetHipNumber: m.hipNumber,
          important: true,
        });
        if (ok) created += 1;
      }
    }
  }
  return created;
}

export async function listEvents(limit: number) {
  const [events, unread] = await Promise.all([
    db.appEvent.findMany({ where: { hiddenAt: null }, orderBy: { createdAt: "desc" }, take: limit }),
    db.appEvent.count({ where: { hiddenAt: null, readAt: null } }),
  ]);
  return { events, unread };
}
