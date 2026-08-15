import { ResolvedSaleDay } from "../types";

// Helper GENÉRICO POR CASA (no exclusivo de ninguna casa en particular):
// arma el Calendario de Ventas (una fila ResolvedSaleDay por día real de
// subasta) a partir de lo único que Fasig-Tipton y OBS pueden dar hoy —
// un Map hipNumber -> fecha de sesión, la misma salida que ya produce
// `resolveSessionDates()` de cualquier casa. Keeneland NO usa este
// helper porque resuelve su calendario desde el PDF público de "Hip
// Grouping" (book/sesión/hora reales) — ver keenelandHipGrouping.ts.
//
// A propósito, este helper solo completa `date`, `hipRangeStart`,
// `hipRangeEnd`, `headCount` y `source`. Deja `book`, `sessionNumber` y
// `startTimeLabel` sin definir: ninguna de las dos casas expone hoy esa
// información por Hip, y el Método RM prohíbe inventar datos que no
// vienen de la fuente real (ver ResolvedSaleDay en types.ts).
export function resolveSaleDaysFromSessionDates(
  sessionDates: Map<string, Date>,
  source: string
): ResolvedSaleDay[] {
  const byDay = new Map<string, { date: Date; hipNumbers: string[] }>();

  for (const [hipNumber, date] of sessionDates) {
    if (isNaN(date.getTime())) continue;
    const dayKey = date.toISOString().slice(0, 10); // agrupa por día calendario, no por instante exacto
    const bucket = byDay.get(dayKey);
    if (bucket) {
      bucket.hipNumbers.push(hipNumber);
    } else {
      byDay.set(dayKey, { date, hipNumbers: [hipNumber] });
    }
  }

  const days: ResolvedSaleDay[] = [];
  for (const { date, hipNumbers } of byDay.values()) {
    // Rango de Hip numérico (mismo criterio que HipRange en iOS,
    // HipListViewModel.swift): los Hip Numbers con letras u otro formato
    // no numérico simplemente no participan del rango — no rompen nada,
    // no se inventa un valor para ellos.
    const numeric = hipNumbers
      .map((n) => parseInt(n, 10))
      .filter((n) => !isNaN(n));
    const hipRangeStart = numeric.length > 0 ? String(Math.min(...numeric)) : undefined;
    const hipRangeEnd = numeric.length > 0 ? String(Math.max(...numeric)) : undefined;

    days.push({
      date,
      hipRangeStart,
      hipRangeEnd,
      headCount: hipNumbers.length,
      source,
    });
  }

  return days.sort((a, b) => a.date.getTime() - b.date.getTime());
}
