// Reference Horse Calibration — pieza (C) del motor.
//
// El caballo referente representa la calibración de conformación correcta
// del Método RM (punto 1 de las instrucciones). Este módulo extrae los
// landmarks de las 3 fotos del referente UNA SOLA VEZ (no en cada análisis
// de Hip — sería carísimo y no aporta nada distinto entre corridas, ya que
// el referente no cambia), corre las mismas reglas RM sobre esos
// landmarks tanto para un CHEQUEO DE CONSISTENCIA (si el propio referente
// saliera "moderado" o "marcado" en algún criterio prioritario, es señal
// de que algo en la extracción o en la calibración de tolerancias
// necesita revisión — se registra como advertencia, nunca bloquea el
// análisis) como para capturar sus VALORES CRUDOS por métrica
// (referenceMetrics), y guarda todo en ReferenceHorse.calibrationJson
// para reusarlo.
//
// CORRECCIÓN DE RAMON (2026-08-14) sobre cómo debe participar el
// referente — reemplaza la nota de diseño anterior de esta misma pieza:
//
//   ESTÁNDAR PROFESIONAL = define la anatomía correcta y protege contra
//     errores. Las bandas de tolerancia de conformationKnowledgeBase.ts
//     siguen siendo absolutas — NUNCA se mueven por el referente. Un
//     carpo desviado 8° del vertical sigue siendo "moderado" aunque el
//     referente mida 8° en esa misma métrica.
//   CABALLO REFERENTE = calibra, DENTRO de esa anatomía correcta, el
//     patrón estructural que valora el Método RM — representa 10.0/10.
//     `referenceMetrics` (ver rmPriorityRules.ts, ReferenceMetrics) es el
//     valor crudo que mide el propio referente en cada métrica geométrica
//     (proporciones, ángulos articulares, offsets de eje) — se usa en
//     severity.ts SOLO para afinar la puntuación DENTRO de la banda ya
//     anatómicamente segura ("Correct"), nunca para reclasificar una
//     desviación real como correcta ni para desplazar el límite de
//     seguridad hacia afuera (ver clamp en severity.classifySeverity).
//
// No es una comparación de "parecido visual": nunca se comparan pixeles,
// colores, musculatura aparente ni tamaño de foto — solo las mismas
// mediciones geométricas (landmarks → ejes → ángulos → proporciones) que
// se usan para cualquier Hip.

import crypto from "crypto";
import { db } from "../db";
import { ReferenceHorseAssets } from "./anthropicClient";
import { fetchAndDownscale } from "./imageDownscale";
import { extractLandmarksFromPhoto } from "./landmarkVisionClient";
import { ViewLandmarks } from "./landmarks";
import { evaluateFrontalFindings, evaluateLateralFindings, evaluatePosteriorFindings, ReferenceMetrics } from "./rmPriorityRules";
import { findDefect } from "./conformationKnowledgeBase";

export interface ReferenceCalibration {
  frontal: ViewLandmarks<"frontal"> | null;
  lateral: ViewLandmarks<"lateral"> | null;
  posterior: ViewLandmarks<"posterior"> | null;
  computedAt: string;
  sourceHash: string;
  /** Hallazgos del propio referente sobre sus 9 criterios prioritarios — se espera que todos den "correct". Si no, queda documentado acá como chequeo de consistencia (ver nota de diseño arriba). */
  consistencyWarnings: string[];
  /** Valores crudos por métrica que mide el propio referente en cada vista — el patrón estructural RM de 10.0/10 (ver nota de diseño arriba). Ausente en calibraciones calculadas antes de 2026-08-14 (se recalculan automáticamente, ver getOrComputeReferenceCalibration). */
  referenceMetrics: { frontal: ReferenceMetrics; lateral: ReferenceMetrics; posterior: ReferenceMetrics };
}

export function referenceSourceHash(assets: ReferenceHorseAssets): string {
  const parts = [assets.lateralPhotoUrl ?? "", assets.frontalPhotoUrl ?? "", assets.posteriorPhotoUrl ?? ""];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

async function extractViewLandmarks<V extends "frontal" | "lateral" | "posterior">(
  url: string,
  view: V,
  label: string
): Promise<ViewLandmarks<V> | null> {
  const jpeg = await fetchAndDownscale(url);
  if (!jpeg) return null;
  const result = await extractLandmarksFromPhoto({ jpeg, photoLabel: label, expectedView: view });
  if (!result.valid) return null;
  return result.landmarks as ViewLandmarks<V>;
}

async function computeCalibration(assets: ReferenceHorseAssets): Promise<ReferenceCalibration> {
  const [frontal, lateral, posterior] = await Promise.all([
    assets.frontalPhotoUrl ? extractViewLandmarks(assets.frontalPhotoUrl, "frontal", "CABALLO REFERENTE — vista frontal") : Promise.resolve(null),
    assets.lateralPhotoUrl ? extractViewLandmarks(assets.lateralPhotoUrl, "lateral", "CABALLO REFERENTE — vista lateral") : Promise.resolve(null),
    assets.posteriorPhotoUrl ? extractViewLandmarks(assets.posteriorPhotoUrl, "posterior", "CABALLO REFERENTE — vista posterior") : Promise.resolve(null),
  ]);

  // IMPORTANTE: acá evaluamos las reglas SOBRE LAS PROPIAS MEDICIONES del
  // referente (ideal=0 abstracto, sin `referenceMetrics` — el referente no
  // se compara consigo mismo con su propio patrón, sería circular). Esto
  // sirve para (a) el chequeo de consistencia de siempre, y (b) capturar
  // `rawMetrics`, que SÍ se guarda como el patrón RM de 10.0/10 para
  // usarse después en cada análisis de Hip (ver nota de diseño arriba).
  const consistencyWarnings: string[] = [];
  let frontalMetrics: ReferenceMetrics = {};
  let lateralMetrics: ReferenceMetrics = {};
  let posteriorMetrics: ReferenceMetrics = {};

  if (frontal) {
    const evalResult = evaluateFrontalFindings(frontal, 1);
    frontalMetrics = evalResult.rawMetrics;
    for (const f of evalResult.findings) {
      if (f.severity !== "correct") {
        const defect = findDefect(f.defectId);
        consistencyWarnings.push(
          `Frontal: el propio referente mide "${f.severity}" en ${defect?.nameEs ?? f.defectId} — revisar calibración/tolerancias.`
        );
      }
    }
  }
  if (lateral) {
    const evalResult = evaluateLateralFindings(lateral, 1);
    lateralMetrics = evalResult.rawMetrics;
    for (const f of evalResult.findings) {
      if (f.severity !== "correct") {
        const defect = findDefect(f.defectId);
        consistencyWarnings.push(
          `Lateral: el propio referente mide "${f.severity}" en ${defect?.nameEs ?? f.defectId} — revisar calibración/tolerancias.`
        );
      }
    }
  }
  if (posterior) {
    const evalResult = evaluatePosteriorFindings(posterior, 1);
    posteriorMetrics = evalResult.rawMetrics;
    for (const f of evalResult.findings) {
      if (f.severity !== "correct") {
        const defect = findDefect(f.defectId);
        consistencyWarnings.push(
          `Posterior: el propio referente mide "${f.severity}" en ${defect?.nameEs ?? f.defectId} — revisar calibración/tolerancias.`
        );
      }
    }
  }

  return {
    frontal,
    lateral,
    posterior,
    computedAt: new Date().toISOString(),
    sourceHash: referenceSourceHash(assets),
    consistencyWarnings,
    referenceMetrics: { frontal: frontalMetrics, lateral: lateralMetrics, posterior: posteriorMetrics },
  };
}

/**
 * Devuelve la calibración vigente del referente de esta organización,
 * recalculando SOLO si nunca se calculó o si las 3 URLs de foto cambiaron
 * desde el último cálculo (se detecta por `sourceHash`) — evita
 * recalcular en cada análisis de Hip.
 */
export async function getOrComputeReferenceCalibration(
  organizationId: string,
  assets: ReferenceHorseAssets
): Promise<ReferenceCalibration | null> {
  if (!assets.lateralPhotoUrl || !assets.frontalPhotoUrl || !assets.posteriorPhotoUrl) return null;

  const currentHash = referenceSourceHash(assets);
  const row = await db.referenceHorse.findUnique({ where: { organizationId_key: { organizationId, key: "default" } } });
  if (row?.calibrationJson && row.calibrationHash === currentHash) {
    const cached = row.calibrationJson as unknown as ReferenceCalibration;
    // Las calibraciones calculadas ANTES de la integración del patrón RM
    // (2026-08-14) no tienen `referenceMetrics` — se recalculan una sola
    // vez automáticamente acá en vez de servir un caché incompleto que
    // dejaría al referente sin influir en el score (ver corrección de
    // Ramon en el comentario grande de arriba).
    if (cached.referenceMetrics) {
      return cached;
    }
  }

  const calibration = await computeCalibration(assets);
  await db.referenceHorse.update({
    where: { organizationId_key: { organizationId, key: "default" } },
    data: {
      calibrationJson: calibration as unknown as object,
      calibrationHash: calibration.sourceHash,
      calibratedAt: new Date(),
    },
  });
  if (calibration.consistencyWarnings.length > 0) {
    console.warn(
      `[analysis] Calibración del referente (org ${organizationId}) con advertencias de consistencia:`,
      calibration.consistencyWarnings
    );
  }
  return calibration;
}
