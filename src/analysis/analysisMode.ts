// Modo de Análisis IA vigente — fuente única en el backend.
//
// MODO LATERAL ÚNICA (2026-09-26, decisión explícita de Ramon): solo la
// vista lateral participa en los análisis IA y en su score. Antes esta
// constante vivía como `const` local dentro de analyzeHipOnDemand
// (rankingService.ts); se movió acá sin cambiar su valor para que el
// Ranking del Día (rankingSelection.ts) use exactamente el mismo criterio
// que el motor de análisis. Espejo del flag `rmSingleLateralAnalysisMode`
// del cliente iOS (HipDetailView.swift) — para reactivar las 3 vistas hay
// que cambiar los dos.
export const RM_SINGLE_LATERAL_ANALYSIS_MODE = true;
