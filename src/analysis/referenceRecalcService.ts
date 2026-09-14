import { db } from "../db";
import { runWithConcurrencyLimit } from "../util/concurrencyPool";
import { config } from "../config";
import { analyzeHipOnDemand } from "../rankingService";
import { MissingReferenceHorseError } from "./anthropicClient";
import { ViewName } from "./landmarks";
import { CatalogMediaItem } from "../types";

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
 */

const MAX_ERROR_SAMPLES_IN_MESSAGE = 20;

export interface ReferenceRecalcSummary {
  runId: string;
  /** Pares Hip×Organización con foto LATERAL vigente (AI_ANALYSIS_PHOTO procesada, no borrada) — el universo real de trabajo de este barrido. */
  pairsEvaluated: number;
  /** Hips DISTINTOS (sin repetir por organización) incluidos en pairsEvaluated — para comparar contra "TOTAL DE HIP CON FOTO LATERAL DISPONIBLE" del punto I tal como lo pide Ramon. */
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
  /** Hips (a nivel catálogo, sin importar organización) sin NINGUNA foto publicada todavía. */
  hipsWithoutPhoto: number;
  /** Hips con foto de catálogo publicada, pero para los que NINGUNA organización llegó a tener una LATERAL válida, y la clasificación automática ya agotó sus reintentos (ver autoLateralPhotoFailedAttempts) — foto disponible pero ninguna resultó ser una lateral utilizable. */
  hipsWithInvalidPhoto: number;
  /** Hips con foto de catálogo publicada, sin LATERAL válida todavía en ninguna organización, pero que TODAVÍA pueden resolverse solos (el barrido de Media nocturno los reintentará) — no agotaron reintentos. */
  hipsPending: number;
  /** Organizaciones que tienen al menos un par pendiente por falta de caballo referente configurado. */
  organizationsWithoutReference: string[];
}

interface LateralPair {
  hip: { id: string; hipNumber: string; horseName: string | null };
  organizationId: string;
}

/**
 * Todos los pares Hip×Organización que hoy tienen una foto LATERAL vigente
 * de Análisis (IA) — cubre A (ya analizados) y B (con foto, sin analizar
 * todavía) de una sola vez: `analyzeHipOnDemand` decide internamente, por
 * par, si hace falta llamar a la IA de nuevo o si ya está al día.
 */
async function findValidLateralPairs(): Promise<LateralPair[]> {
  const assets = await db.mediaAsset.findMany({
    where: { kind: "AI_ANALYSIS_PHOTO", conformationView: "lateral", uploadStatus: "PROCESSED", deletedAt: null },
    select: { hipId: true, organizationId: true },
    distinct: ["hipId", "organizationId"],
  });
  if (assets.length === 0) return [];

  const hipIds = [...new Set(assets.map((a) => a.hipId))];
  const hips = await db.hip.findMany({
    where: { id: { in: hipIds } },
    select: { id: true, hipNumber: true, horseName: true },
  });
  const hipById = new Map(hips.map((h) => [h.id, h]));

  const pairs: LateralPair[] = [];
  for (const a of assets) {
    const hip = hipById.get(a.hipId);
    if (!hip) continue; // Defensivo: no debería pasar (FK), pero nunca revienta el barrido por esto.
    pairs.push({ hip, organizationId: a.organizationId });
  }
  return pairs;
}

/**
 * Desglose a nivel Hip (independiente de organización, porque el catálogo
 * de fotos es compartido) de "sin foto" / "foto no válida" / "pendiente"
 * para el punto I — SOLO para los Hips que quedaron FUERA de
 * `hipsWithValidLateral` (ya cubiertos arriba).
 */
async function classifyHipsWithoutValidLateral(hipsWithValidLateral: Set<string>): Promise<{
  hipsWithoutPhoto: number;
  hipsWithInvalidPhoto: number;
  hipsPending: number;
}> {
  const maxFailedAttempts = config.autoPhotoAnalysisMaxFailedAttempts;
  const allHips = await db.hip.findMany({
    select: { id: true, mediaJson: true, autoLateralPhotoFailedAttempts: true },
  });

  let hipsWithoutPhoto = 0;
  let hipsWithInvalidPhoto = 0;
  let hipsPending = 0;

  for (const hip of allHips) {
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
 * Corre el barrido completo. Seguro para llamar más de una vez (punto G):
 * los pares ya al día con el referente vigente se resuelven casi al
 * instante vía `analyzeHipOnDemand` sin gastar cuota de IA.
 */
export async function runReferenceRecalcSweep(opts: { trigger: "scheduled" | "manual" } = { trigger: "manual" }): Promise<ReferenceRecalcSummary> {
  const run = await db.referenceRecalcRun.create({ data: { trigger: opts.trigger, status: "running" } });

  const errorSamples: string[] = [];
  let reanalyzed = 0;
  let reused = 0;
  let noReference = 0;
  let errorCount = 0;
  const noReferenceOrgs = new Set<string>();

  try {
    const pairs = await findValidLateralPairs();
    const distinctHipIds = new Set(pairs.map((p) => p.hip.id));

    await runWithConcurrencyLimit(pairs, config.referenceRecalcConcurrency, async (pair) => {
      try {
        const result = await analyzeHipOnDemand(pair.hip, pair.organizationId, undefined, "lateral" as ViewName);
        if (result.reused) {
          reused += 1;
        } else {
          reanalyzed += 1;
        }
      } catch (err) {
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

    const { hipsWithoutPhoto, hipsWithInvalidPhoto, hipsPending } = await classifyHipsWithoutValidLateral(distinctHipIds);

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
      organizationsWithoutReference: [...noReferenceOrgs],
    };

    await db.referenceRecalcRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: errorCount > 0 && reanalyzed + reused === 0 && pairs.length > 0 ? "failed" : "completed",
        hipsEvaluated: distinctHipIds.size,
        reanalyzed,
        reused,
        noReference,
        errors: errorCount,
        errorMessage:
          errorSamples.length > 0
            ? errorSamples.join(" | ") + (errorCount > errorSamples.length ? ` … (+${errorCount - errorSamples.length} más, ver detailsJson)` : "")
            : null,
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
