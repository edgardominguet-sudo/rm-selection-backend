import { db } from "../db";
import { runWithConcurrencyLimit } from "../util/concurrencyPool";
import { config } from "../config";
import { analyzeHipOnDemand } from "../rankingService";
import { MissingReferenceHorseError, AnthropicCreditExhaustedError } from "./anthropicClient";
import { ViewName } from "./landmarks";
import { CatalogMediaItem } from "../types";
import { getReferenceHorse } from "../referenceHorse";
import { referenceViewHash } from "./referenceCalibration";

/**
 * BARRIDO DE RECÁLCULO POR CAMBIO DE CABALLO REFERENTE / MOTOR
 * (2026-09-11, a pedido explícito de Ramon — instrucción 18, "RECÁLCULO
 * COMPLETO DE TODOS LOS HIP CON EL NUEVO CABALLO REFERENTE 10/10").
 *
 * Objetivo: después de cambiar el caballo referente (o cualquier parámetro
 * del motor de análisis, ver ENGINE_FORMULA_VERSION en
 * referenceCalibration.ts), garantizar que NINGÚN score activo quede
 * calculado con el patrón anterior — sin importar si el Hip ya tenía un
 * análisis (puntos A/E) o si tiene foto lateral pero todavía no fue
 * analizado (punto B).
 *
 * NO es un mecanismo nuevo de análisis: reusa exactamente
 * `analyzeHipOnDemand` (rankingService.ts) — el mismo motor que usa el
 * botón manual "Analizar" y el pipeline automático de fotos
 * (autoPhotoAnalysis.ts). La única pieza nueva de verdad es
 * `AnalysisResult.viewReferenceHashJson` (ver schema.prisma y
 * referenceCalibration.ts): `analyzeHipOnDemand` ya sabe, por su cuenta,
 * si el resultado guardado de una vista corresponde al referente VIGENTE
 * o a uno viejo, y solo vuelve a llamar a la IA cuando de verdad hace
 * falta (punto G, "evitar costos y procesamiento duplicado") — este
 * barrido simplemente RECORRE todos los Hip×Organización relevantes y
 * llama a esa misma función una vez por cada uno; que sea instantáneo
 * (reusa lo ya vigente) o dispare una llamada real a la IA lo decide
 * `analyzeHipOnDemand`, no este archivo.
 *
 * UNIDAD DE TRABAJO: Hip × Organización, no solo Hip. El catálogo (Hip,
 * fotos) es compartido entre organizaciones, pero el Análisis (IA) —
 * incluida la foto LATERAL usada y el caballo referente contra el que se
 * compara — es 100% propio de cada organización (ver comentario en
 * ReferenceHorse, schema.prisma: "cada una puede tener su propio patrón
 * oficial"). Este barrido cubre TODAS las organizaciones existentes, no
 * asume que haya una sola — si alguna todavía no tiene su caballo
 * referente configurado (las 3 fotos), esos pares quedan contabilizados
 * aparte (`noReference`), nunca se pierden ni se cuentan como error.
 *
 * ALCANCE ACOTADO (2026-09-14, "INSTRUCCIÓN ACTUALIZADA – BARRIDO
 * KEENELAND", a pedido explícito de Ramon): además del barrido global de
 * siempre, este archivo ahora soporta un `ReferenceRecalcFilter` opcional
 * — venta puntual + rango de número de Hip — para poder limitar una
 * corrida a exactamente los Hip que Ramon va a trabajar en persona (ej.
 * "solo HIP 1976 a 4650 de Keeneland, del 21 al 26 de sep"). Sin filtro,
 * el comportamiento es EXACTAMENTE el de siempre (todas las ventas, todos
 * los Hip). Independiente de esto, y de forma PERMANENTE (no solo para
 * este pedido puntual): un Hip marcado OUT/Withdrawn por la casa de venta
 * (`Hip.saleResultJson.soldAsCode === "Y"`, ver `field_out` en
 * saleHouses/keeneland.ts) NUNCA se manda a la IA — no tiene sentido
 * gastar cuota recalculando un caballo que ya se retiró de la venta, y
 * esto reduce costo/tiempo de CUALQUIER corrida futura, acotada o no.
 */

const MAX_ERROR_SAMPLES_IN_MESSAGE = 20;

/**
 * Filtro opcional de alcance para una corrida puntual. `hipNumberMin`/`Max`
 * comparan el valor NUMÉRICO de `Hip.hipNumber` (que ya se guarda sin
 * ceros a la izquierda, ver `normalizeHipNumber` en saleHouses/keeneland.ts)
 * — un Hip cuyo número no sea puramente numérico (ej. un sufijo de letra,
 * rarísimo pero posible) queda afuera de cualquier filtro por rango, nunca
 * se incluye "por las dudas".
 */
export interface ReferenceRecalcFilter {
  saleId?: string;
  hipNumberMin?: number;
  hipNumberMax?: number;
}

function hipNumberInRange(hipNumber: string, filter?: ReferenceRecalcFilter): boolean {
  if (!filter || (filter.hipNumberMin === undefined && filter.hipNumberMax === undefined)) return true;
  const n = Number(hipNumber);
  if (!Number.isFinite(n) || !/^\d+$/.test(hipNumber.trim())) return false;
  if (filter.hipNumberMin !== undefined && n < filter.hipNumberMin) return false;
  if (filter.hipNumberMax !== undefined && n > filter.hipNumberMax) return false;
  return true;
}

/** `true` si la casa de venta marcó este Hip como retirado (OUT/Withdrawn) — ver comentario grande arriba. Nunca se manda a la IA. */
function isOut(saleResultJson: unknown): boolean {
  const code = (saleResultJson as { soldAsCode?: string } | null)?.soldAsCode;
  return code === "Y";
}

export interface ReferenceRecalcSummary {
  runId: string;
  /** Pares Hip×Organización con foto LATERAL vigente (AI_ANALYSIS_PHOTO procesada, no borrada), dentro del filtro y sin contar Hip OUT — el universo real de trabajo de esta corrida. */
  pairsEvaluated: number;
  /** Hips DISTINTOS (sin repetir por organización) incluidos en pairsEvaluated. */
  hipsEvaluated: number;
  /** De los pares evaluados: la IA corrió de nuevo porque la vista estaba "sucia" (foto y/o referente cambiado desde el último resultado guardado). */
  reanalyzed: number;
  /** De los pares evaluados: el resultado guardado YA correspondía al referente/foto vigentes — se reusó sin gastar cuota (punto G). */
  reused: number;
  /** Pares con foto lateral válida pero cuya organización todavía no tiene caballo referente configurado (las 3 fotos) — no es un error, es un prerequisito pendiente de esa organización puntual. */
  noReference: number;
  /** Fallo técnico real (no MissingReferenceHorseError) al intentar analizar un par puntual — no detiene el resto del barrido (punto H). */
  errors: number;
  errorSamples: string[];
  /** Hips dentro del filtro, activos (no OUT), sin NINGUNA foto de catálogo publicada todavía. */
  hipsWithoutPhoto: number;
  /** Hips dentro del filtro, activos, con foto de catálogo publicada, pero para los que NINGUNA organización llegó a tener una LATERAL válida y la clasificación automática ya agotó sus reintentos. */
  hipsWithInvalidPhoto: number;
  /** Hips dentro del filtro, activos, con foto de catálogo publicada, sin LATERAL válida todavía, pero que pueden resolverse solos (el barrido de Media nocturno los reintentará). */
  hipsPending: number;
  /** Hips dentro del filtro marcados OUT/Withdrawn — excluidos por completo, nunca enviados a la IA. */
  hipsOut: number;
  /** Organizaciones que tienen al menos un par pendiente por falta de caballo referente configurado. */
  organizationsWithoutReference: string[];
  /** Filtro efectivamente aplicado a esta corrida (null = sin acotar, alcance global). */
  filter: ReferenceRecalcFilter | null;
}

interface LateralPair {
  hip: { id: string; hipNumber: string; horseName: string | null };
  organizationId: string;
  lateralAssetId: string;
}

/**
 * Hips activos (no OUT) dentro del filtro, con sus datos base (número,
 * saleResultJson) — punto de partida compartido por el barrido real y por
 * el preview de solo lectura, para no duplicar el criterio de exclusión en
 * dos lugares.
 */
async function findActiveHipsInFilter(filter?: ReferenceRecalcFilter): Promise<{
  id: string;
  hipNumber: string;
  horseName: string | null;
}[]> {
  const allHips = await db.hip.findMany({
    where: filter?.saleId ? { saleId: filter.saleId } : undefined,
    select: { id: true, hipNumber: true, horseName: true, saleResultJson: true },
  });
  return allHips
    .filter((h) => hipNumberInRange(h.hipNumber, filter))
    .filter((h) => !isOut(h.saleResultJson))
    .map((h) => ({ id: h.id, hipNumber: h.hipNumber, horseName: h.horseName }));
}

/**
 * Todos los pares Hip×Organización que hoy tienen una foto LATERAL vigente
 * de Análisis (IA) — cubre A (ya analizados) y B (con foto, sin analizar
 * todavía) de una sola vez: `analyzeHipOnDemand` decide internamente, por
 * par, si hace falta llamar a la IA de nuevo o si ya está al día. Excluye
 * SIEMPRE los Hip OUT/Withdrawn, y respeta el `filter` opcional de venta +
 * rango de número (ver comentario grande arriba del archivo).
 */
async function findValidLateralPairs(filter?: ReferenceRecalcFilter): Promise<LateralPair[]> {
  const activeHips = await findActiveHipsInFilter(filter);
  if (activeHips.length === 0) return [];
  const activeHipById = new Map(activeHips.map((h) => [h.id, h]));

  const assets = await db.mediaAsset.findMany({
    where: {
      hipId: { in: [...activeHipById.keys()] },
      kind: "AI_ANALYSIS_PHOTO",
      conformationView: "lateral",
      uploadStatus: "PROCESSED",
      deletedAt: null,
    },
    select: { id: true, hipId: true, organizationId: true },
    // Última foto lateral vigente por Hip×Organización primero, para que
    // el `distinct` se quede con la más reciente si por algún motivo
    // hubiera más de una activa (no debería, ver autoPhotoAnalysis.ts,
    // "una foto = un registro").
    orderBy: { createdAt: "desc" },
    distinct: ["hipId", "organizationId"],
  });

  const pairs: LateralPair[] = [];
  for (const a of assets) {
    const hip = activeHipById.get(a.hipId);
    if (!hip) continue; // Fuera del filtro o OUT — nunca se manda a la IA.
    pairs.push({ hip, organizationId: a.organizationId, lateralAssetId: a.id });
  }
  return pairs;
}

/**
 * Desglose a nivel Hip (independiente de organización, porque el catálogo
 * de fotos es compartido) de "sin foto" / "foto no válida" / "pendiente"
 * para el punto I — SOLO para los Hip ACTIVOS (no OUT) dentro del filtro
 * que quedaron FUERA de `hipsWithValidLateral` (ya cubiertos arriba).
 */
async function classifyActiveHipsWithoutValidLateral(
  hipsWithValidLateral: Set<string>,
  filter?: ReferenceRecalcFilter
): Promise<{
  hipsWithoutPhoto: number;
  hipsWithInvalidPhoto: number;
  hipsPending: number;
}> {
  const maxFailedAttempts = config.autoPhotoAnalysisMaxFailedAttempts;
  const activeHips = await db.hip.findMany({
    where: filter?.saleId ? { saleId: filter.saleId } : undefined,
    select: { id: true, hipNumber: true, mediaJson: true, autoLateralPhotoFailedAttempts: true, saleResultJson: true },
  });

  let hipsWithoutPhoto = 0;
  let hipsWithInvalidPhoto = 0;
  let hipsPending = 0;

  for (const hip of activeHips) {
    if (!hipNumberInRange(hip.hipNumber, filter)) continue;
    if (isOut(hip.saleResultJson)) continue; // Contado aparte como hipsOut.
    if (hipsWithValidLateral.has(hip.id)) continue;
    const media = (Array.isArray(hip.mediaJson) ? hip.mediaJson : []) as unknown as CatalogMediaItem[];
    const hasPhoto = media.some((m) => m.kind === "photo" && !!m.url);
    if (!hasPhoto) {
      hipsWithoutPhoto += 1;
      continue;
    }
    if (hip.autoLateralPhotoFailedAttempts >= maxFailedAttempts) {
      hipsWithInvalidPhoto += 1;
    } else {
      hipsPending += 1;
    }
  }

  return { hipsWithoutPhoto, hipsWithInvalidPhoto, hipsPending };
}

/**
 * Cuenta los Hip OUT/Withdrawn dentro del filtro — informativo, para el
 * punto 9 del pedido de Ramon ("cantidad de OUT/Withdrawn detectados").
 */
async function countOutHipsInFilter(filter?: ReferenceRecalcFilter): Promise<number> {
  const allHips = await db.hip.findMany({
    where: filter?.saleId ? { saleId: filter.saleId } : undefined,
    select: { hipNumber: true, saleResultJson: true },
  });
  return allHips.filter((h) => hipNumberInRange(h.hipNumber, filter) && isOut(h.saleResultJson)).length;
}

export interface ReferenceRecalcPreview {
  filter: ReferenceRecalcFilter;
  /** Total de Hip dentro del filtro (venta + rango de número), OUT incluidos. */
  totalInRange: number;
  /** De esos, cuántos están marcados OUT/Withdrawn — excluidos, nunca se envían a la IA. */
  outCount: number;
  /** Hip activos (no OUT) dentro del filtro. */
  activeInRange: number;
  /** De los activos: cuántos tienen ya una foto LATERAL vigente en al menos una organización (son los que este barrido realmente evalúa). */
  activeWithValidLateral: number;
  /** De los pares activos con LATERAL vigente: cuántos YA están al día con el referente/foto actuales — no se les vuelve a llamar a la IA (gratis, punto G). */
  pairsAlreadyUpToDate: number;
  /** De los pares activos con LATERAL vigente: cuántos están "sucios" (foto y/o referente cambiado) y por lo tanto SÍ dispararán una llamada real a la IA si se ejecuta el barrido. Es la cifra que más le importa a Ramon para dimensionar el gasto real. */
  pairsToSend: number;
  /** Hip activos dentro del filtro que todavía no tienen ninguna LATERAL válida en ninguna organización (sin foto, foto no válida, o pendiente de clasificar) — quedan fuera de ESTE barrido, ver hipsWithoutPhoto/hipsWithInvalidPhoto/hipsPending de una corrida real para el desglose fino. */
  activeWithoutValidLateral: number;
}

/**
 * Calcula, SIN llamar a la IA ni gastar un solo crédito, exactamente lo
 * que un `runReferenceRecalcSweep(filter)` real haría — pensado para
 * responder el punto 9 de Ramon ("infórmame los números antes de
 * ejecutar") sin ningún costo ni efecto secundario. Réplica de solo
 * lectura de la lógica de "¿está sucia esta vista?" de `analyzeHipOnDemand`
 * (rankingService.ts) — comparar el id de la foto lateral vigente y el
 * hash del referente vigente contra lo guardado en el último análisis —
 * pero sin transacción, sin candado, sin tocar la base de datos.
 */
export async function previewReferenceRecalcSweep(filter: ReferenceRecalcFilter): Promise<ReferenceRecalcPreview> {
  const [totalInRangeHips, outCount, pairs] = await Promise.all([
    (async () => {
      const allHips = await db.hip.findMany({
        where: filter.saleId ? { saleId: filter.saleId } : undefined,
        select: { hipNumber: true },
      });
      return allHips.filter((h) => hipNumberInRange(h.hipNumber, filter)).length;
    })(),
    countOutHipsInFilter(filter),
    findValidLateralPairs(filter),
  ]);

  const activeInRange = await db.hip
    .count({ where: filter.saleId ? { saleId: filter.saleId } : undefined })
    .then(async () => {
      // Recontar con el mismo criterio activo/rango que el resto del
      // archivo (evita un tercer camino de filtrado): total en rango menos
      // OUT en rango.
      return totalInRangeHips - outCount;
    });

  const distinctHipIds = new Set(pairs.map((p) => p.hip.id));

  // Hash de referente vigente por organización — se calcula una sola vez
  // por organización distinta entre los pares (normalmente una sola).
  const refHashByOrg = new Map<string, string>();
  for (const orgId of new Set(pairs.map((p) => p.organizationId))) {
    const reference = await getReferenceHorse(orgId);
    refHashByOrg.set(orgId, referenceViewHash(reference.lateralPhotoUrl));
  }

  let pairsAlreadyUpToDate = 0;
  let pairsToSend = 0;
  for (const pair of pairs) {
    const pointer = await db.currentHipAnalysis.findUnique({
      where: { hipId_organizationId: { hipId: pair.hip.id, organizationId: pair.organizationId } },
      include: { analysisResult: true },
    });
    if (!pointer) {
      pairsToSend += 1;
      continue;
    }
    const prevSourceIds = (pointer.analysisResult.viewSourceAssetIdsJson as Partial<Record<ViewName, string>> | null) ?? null;
    const prevRefHashes = (pointer.analysisResult.viewReferenceHashJson as Partial<Record<ViewName, string>> | null) ?? null;
    const idChanged = (pair.lateralAssetId ?? null) !== (prevSourceIds?.lateral ?? null);
    const currentRefHash = refHashByOrg.get(pair.organizationId) ?? "";
    const refChanged = (prevRefHashes?.lateral ?? null) !== currentRefHash;
    if (idChanged || refChanged) {
      pairsToSend += 1;
    } else {
      pairsAlreadyUpToDate += 1;
    }
  }

  return {
    filter,
    totalInRange: totalInRangeHips,
    outCount,
    activeInRange,
    activeWithValidLateral: distinctHipIds.size,
    pairsAlreadyUpToDate,
    pairsToSend,
    activeWithoutValidLateral: activeInRange - distinctHipIds.size,
  };
}

/**
 * Corre el barrido completo (o acotado por `opts.filter`, ver
 * `ReferenceRecalcFilter`). Seguro para llamar más de una vez (punto G):
 * los pares ya al día con el referente vigente se resuelven casi al
 * instante vía `analyzeHipOnDemand` sin gastar cuota de IA. Los Hip
 * OUT/Withdrawn quedan SIEMPRE excluidos, filtro o no (ver comentario
 * grande arriba del archivo).
 */
export async function runReferenceRecalcSweep(
  opts: { trigger: "scheduled" | "manual"; filter?: ReferenceRecalcFilter } = { trigger: "manual" }
): Promise<ReferenceRecalcSummary> {
  const filter = opts.filter ?? null;
  const run = await db.referenceRecalcRun.create({ data: { trigger: opts.trigger, status: "running" } });

  const errorSamples: string[] = [];
  let reanalyzed = 0;
  let reused = 0;
  let noReference = 0;
  let errorCount = 0;
  const noReferenceOrgs = new Set<string>();
  // AGREGADO 2026-09-15 (mismo criterio que mediaSweepService.ts — ver
  // AnthropicCreditExhaustedError): si se agota el saldo de Anthropic a
  // mitad de un recálculo, no tiene sentido seguir probando el resto de los
  // pares contra la misma pared, ni contarlos como "errorCount" genéricos
  // (eso sugeriría un problema real de esos Hips puntuales, cuando en
  // realidad es una condición de toda la cuenta).
  let creditExhausted = false;

  try {
    const pairs = await findValidLateralPairs(filter ?? undefined);
    const distinctHipIds = new Set(pairs.map((p) => p.hip.id));

    await runWithConcurrencyLimit(pairs, config.referenceRecalcConcurrency, async (pair) => {
      if (creditExhausted) return;
      try {
        const result = await analyzeHipOnDemand(pair.hip, pair.organizationId, undefined, "lateral" as ViewName);
        if (result.reused) {
          reused += 1;
        } else {
          reanalyzed += 1;
        }
      } catch (err) {
        if (err instanceof AnthropicCreditExhaustedError) {
          creditExhausted = true;
          return;
        }
        if (err instanceof MissingReferenceHorseError) {
          noReference += 1;
          noReferenceOrgs.add(pair.organizationId);
          return;
        }
        // Un fallo puntual (red, IA, base de datos) para UN par NUNCA
        // detiene el resto del barrido (punto H) — se registra y se sigue.
        errorCount += 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[reference-recalc] Hip ${pair.hip.hipNumber}, org ${pair.organizationId}: error al recalcular:`, err);
        if (errorSamples.length < MAX_ERROR_SAMPLES_IN_MESSAGE) {
          errorSamples.push(`Hip ${pair.hip.hipNumber} (org ${pair.organizationId}): ${message}`);
        }
      }
    });

    const [{ hipsWithoutPhoto, hipsWithInvalidPhoto, hipsPending }, hipsOut] = await Promise.all([
      classifyActiveHipsWithoutValidLateral(distinctHipIds, filter ?? undefined),
      countOutHipsInFilter(filter ?? undefined),
    ]);

    const summary: ReferenceRecalcSummary = {
      runId: run.id,
      pairsEvaluated: pairs.length,
      hipsEvaluated: distinctHipIds.size,
      reanalyzed,
      reused,
      noReference,
      errors: errorCount,
      errorSamples,
      hipsWithoutPhoto,
      hipsWithInvalidPhoto,
      hipsPending,
      hipsOut,
      organizationsWithoutReference: [...noReferenceOrgs],
      filter,
    };

    const creditExhaustedMessage = creditExhausted
      ? `Se agotó el saldo de la cuenta de Anthropic durante el recálculo — se detuvo antes de terminar los ${pairs.length} pares evaluables. Lo ya recalculado (${reanalyzed} reanálisis, ${reused} reusados) quedó guardado correctamente. Recargar saldo en console.anthropic.com y volver a correr el recálculo para completar lo que falta.`
      : null;

    await db.referenceRecalcRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: creditExhausted || (errorCount > 0 && reanalyzed + reused === 0 && pairs.length > 0) ? "failed" : "completed",
        hipsEvaluated: distinctHipIds.size,
        reanalyzed,
        reused,
        noReference,
        errors: errorCount,
        errorMessage:
          creditExhaustedMessage ??
          (errorSamples.length > 0
            ? errorSamples.join(" | ") + (errorCount > errorSamples.length ? ` … (+${errorCount - errorSamples.length} más, ver detailsJson)` : "")
            : null),
        detailsJson: summary as unknown as object,
      },
    });

    return summary;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.referenceRecalcRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), status: "failed", errorMessage: message },
    });
    throw err;
  }
}
