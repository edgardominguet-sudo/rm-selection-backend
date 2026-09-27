// Ranking del Día de punta a punta contra una base Postgres real
// (2026-09-26, decisiones confirmadas por Ramon). Ejercita el camino real
// de producción — analyzeAndRankSession -> rebuildRankingSnapshot ->
// RankingSnapshot — con ventas, Hips y análisis reales en la base: Hips
// sin analizar, análisis inválidos, reanálisis que suben y bajan, empates,
// más y menos de 10, otra venta el mismo día y una venta terminada.
// Nunca llama a la IA: los análisis se insertan directo como filas.
import { randomUUID } from "node:crypto";
import { db } from "../../src/db";
import { analyzeAndRankSession } from "../../src/rankingService";
import { startOfCalendarDay } from "../../src/util/easternCalendarDay";

jest.setTimeout(60000);

type Entry = { rank: number; hipNumber: string; overallScore: number };

let organizationId: string;
const createdSaleIds: string[] = [];
let sessionDate: Date;
let dayStart: Date;

async function createSale(opts: { house: "KEENELAND" | "OBS"; isActive: boolean; startDate: Date; endDate: Date }) {
  const sale = await db.sale.create({
    data: {
      house: opts.house,
      name: `Ranking Test ${randomUUID()}`,
      externalSaleId: `rank-test-${randomUUID()}`,
      isActive: opts.isActive,
      catalogAccess: "FULL",
      startDate: opts.startDate,
      endDate: opts.endDate,
    },
  });
  createdSaleIds.push(sale.id);
  return sale;
}

async function createHip(saleId: string, hipNumber: string, date: Date | null = sessionDate) {
  return db.hip.create({ data: { saleId, hipNumber, horseName: `Hip ${hipNumber}`, sessionDate: date } });
}

/** Guarda un análisis como lo haría el motor y lo deja como VIGENTE (CurrentHipAnalysis). */
async function setAnalysis(hipId: string, score: number, opts: { source?: "AI" | "MANUAL"; lateralAvailable?: boolean } = {}) {
  const count = await db.analysisResult.count({ where: { hipId, organizationId } });
  const result = await db.analysisResult.create({
    data: {
      hipId,
      organizationId,
      version: count + 1,
      source: opts.source ?? "AI",
      conformationScoresJson: { "lateral.proportions": score, "lateral.topline": score, "lateral.structure": score },
      overallScore: score,
      classification: score >= 8.5 ? "Comprar" : score >= 7 ? "Revisar" : "Descartar",
      landmarksJson: { lateral: { available: opts.lateralAvailable ?? true }, frontal: { available: false }, posterior: { available: false } },
      model: "test",
    },
  });
  await db.currentHipAnalysis.upsert({
    where: { hipId_organizationId: { hipId, organizationId } },
    create: { hipId, organizationId, analysisResultId: result.id },
    update: { analysisResultId: result.id },
  });
}

async function ranking(saleId: string): Promise<{ entries: Entry[]; analyzed: number } | null> {
  await analyzeAndRankSession(saleId, organizationId, sessionDate);
  const snap = await db.rankingSnapshot.findUnique({
    where: { organizationId_saleId_sessionDate: { organizationId, saleId, sessionDate: dayStart } },
  });
  return snap ? { entries: snap.entriesJson as unknown as Entry[], analyzed: snap.analyzedHipsToday } : null;
}

const hipNumbers = (r: { entries: Entry[] } | null) => (r ? r.entries.map((e) => e.hipNumber) : []);

beforeAll(async () => {
  // Aísla la prueba: ninguna otra venta de la base de test puede competir
  // por ser "la venta activa".
  await db.sale.updateMany({ where: { name: { not: { startsWith: "Ranking Test" } } }, data: { isActive: false } });
  const organization = await db.organization.create({ data: { name: `Ranking Org ${randomUUID()}` } });
  organizationId = organization.id;
  sessionDate = new Date(Date.now() + 60 * 60 * 1000); // jornada dentro de 1h
  dayStart = startOfCalendarDay(sessionDate);
});

afterAll(async () => {
  for (const id of createdSaleIds) await db.sale.delete({ where: { id } }).catch(() => {});
  await db.organization.delete({ where: { id: organizationId } }).catch(() => {});
});

describe("Ranking del Día (base real)", () => {
  test("todas las reglas, de punta a punta", async () => {
    const keeneland = await createSale({ house: "KEENELAND", isActive: true, startDate: sessionDate, endDate: sessionDate });
    // Otra venta el MISMO día, con mejores scores — no es la venta activa.
    const obs = await createSale({ house: "OBS", isActive: false, startDate: sessionDate, endDate: sessionDate });

    // 12 Hips válidos: 8.0, 8.1 ... 9.1 (Hip 101..112)
    const hips: Record<string, string> = {};
    for (let i = 0; i < 12; i++) {
      const h = await createHip(keeneland.id, String(101 + i));
      hips[h.hipNumber] = h.id;
      await setAnalysis(h.id, Math.round((8 + i * 0.1) * 10) / 10);
    }
    // Inválidos: sin analizar, puntaje manual, lateral no evaluada, score 0
    await createHip(keeneland.id, "201");
    const manual = await createHip(keeneland.id, "202");
    await setAnalysis(manual.id, 9.9, { source: "MANUAL" });
    const noLateral = await createHip(keeneland.id, "203");
    await setAnalysis(noLateral.id, 9.9, { lateralAvailable: false });
    const zero = await createHip(keeneland.id, "204");
    await setAnalysis(zero.id, 0);
    // Otro día de la MISMA venta
    const otherDay = await createHip(keeneland.id, "205", new Date(sessionDate.getTime() + 2 * 24 * 60 * 60 * 1000));
    await setAnalysis(otherDay.id, 9.9);
    // Hips de OTRA venta, mismo día, mejor score
    for (const n of ["101", "999"]) {
      const h = await createHip(obs.id, n);
      await setAnalysis(h.id, 9.95);
    }

    // Más de 10 analizados -> solo los 10 mejores, de mayor a menor
    let r = await ranking(keeneland.id);
    expect(r).not.toBeNull();
    expect(r!.entries).toHaveLength(10);
    expect(r!.analyzed).toBe(12);
    expect(hipNumbers(r)).toEqual(["112", "111", "110", "109", "108", "107", "106", "105", "104", "103"]);
    expect(r!.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    // Sin analizar / inválidos / otro día / otra venta -> NO aparecen
    for (const n of ["201", "202", "203", "204", "205", "999"]) expect(hipNumbers(r)).not.toContain(n);

    // Reanálisis con score mayor -> entra primero
    await setAnalysis(hips["101"], 9.8);
    r = await ranking(keeneland.id);
    expect(hipNumbers(r)[0]).toBe("101");
    expect(hipNumbers(r)).not.toContain("103");

    // Reanálisis con score menor -> sale del Top
    await setAnalysis(hips["112"], 5.0);
    r = await ranking(keeneland.id);
    expect(hipNumbers(r)).not.toContain("112");
    expect(hipNumbers(r)).toContain("103");
    expect(r!.entries).toHaveLength(10);

    // Empates -> número de HIP menor primero
    await setAnalysis(hips["110"], 9.5);
    await setAnalysis(hips["104"], 9.5);
    r = await ranking(keeneland.id);
    expect(hipNumbers(r).slice(0, 3)).toEqual(["101", "104", "110"]);
    // Siempre ordenado de mayor a menor
    const scores = r!.entries.map((e) => e.overallScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // La otra venta (no activa) NUNCA genera ranking
    expect(await ranking(obs.id)).toBeNull();
  });

  test("menos de 10 analizados -> solo los existentes; venta terminada -> sin ranking nuevo", async () => {
    // Deja activa SOLO esta venta
    await db.sale.updateMany({ where: { id: { in: createdSaleIds } }, data: { isActive: false } });
    const small = await createSale({ house: "KEENELAND", isActive: true, startDate: sessionDate, endDate: sessionDate });
    const a = await createHip(small.id, "1");
    await setAnalysis(a.id, 7.5);
    const b = await createHip(small.id, "2");
    await setAnalysis(b.id, 8.5);
    await createHip(small.id, "3"); // sin analizar
    const r = await ranking(small.id);
    expect(hipNumbers(r)).toEqual(["2", "1"]);
    expect(r!.analyzed).toBe(2);

    // Venta terminada hace días: queda como historial, no se genera nada
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const completed = await createSale({ house: "KEENELAND", isActive: true, startDate: past, endDate: past });
    const h = await db.hip.create({ data: { saleId: completed.id, hipNumber: "1", sessionDate: past } });
    await setAnalysis(h.id, 9.9);
    await analyzeAndRankSession(completed.id, organizationId, past);
    expect(await db.rankingSnapshot.count({ where: { saleId: completed.id } })).toBe(0);
  });
});
