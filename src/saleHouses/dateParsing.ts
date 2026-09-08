// Parseo tolerante de la fecha de nacimiento ("foaling date") tal como la
// publican las casas de venta en sus catálogos crudos — pedido explícito de
// Ramon (2026-09-07, "MODIFICACIÓN DEL PDF COMPARTIDO — PADRE, MADRE Y
// FECHA DE NACIMIENTO"): agregar "Foaled: May 16, 2025" al PDF de cada Hip,
// SIN introducir la fecha a mano.
//
// Verificado con datos REALES en vivo antes de escribir este parser
// (2026-09-07):
// - Keeneland ("field_foaling_date" del catálogo de September Yearling
//   Sale 2026): formato "MM/DD/YYYY", ej. "02/15/2025".
// - Fasig-Tipton: el campo que el catálogo llama literalmente "foaled" NO
//   es una fecha — es el estado de nacimiento (ej. "NY" = New York-bred,
//   ver FasigTiptonHipCatalogEntry.foaled del lado de la app, que decodifica
//   ese mismo campo con un nombre engañoso). La fecha real de nacimiento
//   viene en el campo "year_of_birth" (pese al nombre, trae la fecha
//   completa) con el MISMO formato "MM/DD/YYYY", ej. "03/27/2025" —
//   confirmado con varios Hips reales de una venta en vivo.
//
// Se acepta también "YYYY-MM-DD" (ISO) como respaldo, por si una venta
// futura o otra casa (OBS, un import manual) lo entrega en ese formato.
// Nunca lanza: una fecha no reconocible devuelve `undefined` y el resto de
// la sincronización del Hip sigue con normalidad — mismo criterio que
// `extractFoalYear` en keeneland.ts.
export function parseFoalingDate(raw: string | null | undefined): Date | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const mdy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    return toNoonUTCDate(Number(mdy[3]), Number(mdy[1]), Number(mdy[2]));
  }

  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return toNoonUTCDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  return undefined;
}

// Mediodía UTC (mismo criterio que el resto del backend para fechas de
// calendario sin componente horario real — ver resolveSessionDates en
// fasigTipton.ts/keeneland.ts — así se evita que un huso horario negativo
// corra la fecha un día para atrás al mostrarla).
function toNoonUTCDate(year: number, month: number, day: number): Date | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  if (year < 1990 || year > 2100) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  // Date normaliza en silencio un desborde (ej. "31" de abril) en vez de
  // lanzar un error — se verifica que los componentes hayan quedado
  // exactamente como se pidieron para descartar esos casos.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date;
}
