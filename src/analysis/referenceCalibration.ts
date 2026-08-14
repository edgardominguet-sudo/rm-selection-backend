// Reference Horse Calibration — pieza (C) del motor.
//
// El caballo referente representa la calibración de conformación correcta
// del Método RM (punto 1 de las instrucciones). Este módulo extrae los
// landmarks de las 3 fotos del referente UNA SOLA VEZ (no en cada análisis
// de Hip — sería carísimo y no aporta nada distinto entre corridas, ya que
// el referente no cambia), corre las mismas reglas RM sobre esos
// landmarks como CHEQUEO DE CONSISTENCIA (si el propio referente saliera
// "moderado" o "marcado" en algún criterio prioritario, es señal de que
// algo en la extracción o en la calibración de tolerancias necesita
// revisión — se registra como advertencia, nunca bloquea el análisis), y
// guarda el resultado en ReferenceHorse.calibrationJson para reusarlo.
//
// Nota de diseño (para el reporte a Ramon): las tolerancias de
// conformationKnowledgeBase.ts son estándares profesionales absolutos
// (ángulos/proporciones de referencias veterinarias), NO relativas al
// referente puntual — un carpo desviado 3° del vertical es una desviación
// de 3°, sea cual sea el caballo. El referente calibra el CRITERIO del
// Método RM (qué le importa a Ramon, con qué peso) y sirve de chequeo de
// cordura del motor, pero no reemplaza los ángulos anatómicos
// profesionales por los del caballo puntual que se haya cargado — así el
// motor no se "malacostumbra" si alguna vez el referente tiene una sola
// foto con una perspectiva imperfecta.

import crypto from "crypto";
import { db } from "../db";
import { ReferenceHorseAssets } from "./anthropicClient";
import { fetchAndDownscale } from "./imageDownscale";
import { extractLandmarksFromPhoto } from "./landmarkVisionClient";
import { ViewLandmarks } from "./landmarks";
import { evaluateFrontalFindings, evaluateLateralFindings, evaluatePosteriorFindings } from "./rmPriorityRules";
import { findDefect } from "./conformationKnowledgeBase";

export interface ReferenceCalibration {
  frontal: ViewLandmarks<"frontal"> | null;
  lateral: ViewLandmarks<"lateral"> | null;
  posterior: ViewLandmarks<"posterior"> | null;
  computedAt: string;
  sourceHash: string;
  /** Hallazgos del propio referente sobre sus 9 criterios prioritarios — se espera que todos den "correct". Si no, queda documentado acá como chequeo de consistencia (ver nota de diseño arriba). */
  consistencyWarnings: string[];
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

  const consistencyWarnings: string[] = [];
  if (frontal) {
    for (const f of evaluateFrontalFindings(frontal, 1)) {
      if (f.severity !== "correct") {
        const defect = findDefect(f.defectId);
        consistencyWarnings.push(
          `Frontal: el propio referente mide "${f.severity}" en ${defect?.nameEs ?? f.defectId} — revisar calibración/tolerancias.`
        );
      }
    }
  }
  if (lateral) {
    for (const f of evaluateLateralFindings(lateral, 1)) {
      if (f.severity !== "correct") {
        const defect = findDefect(f.defectId);
        consistencyWarnings.push(
          `Lateral: el propio referente mide "${f.severity}" en ${defect?.nameEs ?? f.defectId} — revisar calibración/tolerancias.`
        );
      }
    }
  }
  if (posterior) {
    for (const f of evaluatePosteriorFindings(posterior, 1)) {
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
    return row.calibrationJson as unknown as ReferenceCalibration;
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
