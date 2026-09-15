// TRIPWIRE DE REGRESIÓN — regla explícita de Ramon (2026-09-15, "IMPORTANTE
// — MANTENER SIEMPRE HABILITADO EL ANÁLISIS MANUAL"):
//
//   "La opción de ANALIZAR MANUALMENTE un HIP debe permanecer SIEMPRE
//   activa y disponible. NO eliminarla, NO deshabilitarla y NO hacer que
//   dependa de que el barrido automático haya terminado... AUTOMÁTICO =
//   comodidad y procesamiento masivo. MANUAL = respaldo y control directo
//   del usuario. Uno NO debe sustituir al otro."
//
// Esta regla es fácil de romper sin darse cuenta en un refactor futuro
// (ej. "optimizar" agregando un chequeo de `sweepInProgress` a la ruta
// manual, o hacer que el botón dependa de una bandera de barrido). Este
// test no valida comportamiento en runtime (eso requeriría DB — ver
// tests/integration) sino que inspecciona el CÓDIGO FUENTE en busca de
// las invariantes estructurales que garantizan la regla, y falla fuerte
// y explícito si alguna desaparece.
import * as fs from "fs";
import * as path from "path";

const routesSrc = fs.readFileSync(path.join(__dirname, "../../src/api/routes.ts"), "utf8");
const rankingServiceSrc = fs.readFileSync(path.join(__dirname, "../../src/rankingService.ts"), "utf8");
const autoPhotoAnalysisSrc = fs.readFileSync(
  path.join(__dirname, "../../src/analysis/autoPhotoAnalysis.ts"),
  "utf8"
);

/** Extrae el cuerpo de un handler `router.METHOD("path", ...)` hasta el próximo `router.` de nivel superior (heurística de texto — suficiente para este chequeo estructural, no un parser real). */
function extractRouteHandler(src: string, routeDeclaration: string): string {
  const start = src.indexOf(routeDeclaration);
  expect(start).toBeGreaterThanOrEqual(0); // si esto falla, la ruta cambió de firma/ubicación — hay que actualizar este test a mano
  const rest = src.slice(start + routeDeclaration.length);
  const nextRouteMatch = rest.match(/\nrouter\.(get|post|put|delete|patch)\(/);
  return nextRouteMatch ? rest.slice(0, nextRouteMatch.index) : rest;
}

describe("Block 1 — el análisis manual (POST /hips/:hipId/analysis) siempre debe estar disponible", () => {
  const manualAnalysisHandler = extractRouteHandler(routesSrc, 'router.post("/hips/:hipId/analysis"');

  test("la ruta manual existe", () => {
    expect(manualAnalysisHandler.length).toBeGreaterThan(0);
  });

  test("la ruta manual llama a analyzeHipOnDemand — el MISMO motor que usa el barrido automático (nunca un motor separado, para no generar 2 análisis distintos del mismo Hip)", () => {
    expect(manualAnalysisHandler).toMatch(/analyzeHipOnDemand\(/);
  });

  test("el barrido automático (autoPhotoAnalysis.ts) también usa analyzeHipOnDemand — mismo motor en los 2 caminos", () => {
    expect(autoPhotoAnalysisSrc).toMatch(/analyzeHipOnDemand\(/);
    expect(autoPhotoAnalysisSrc).toMatch(/from ["']\.\.\/rankingService["']/);
  });

  test("la ruta manual NO debe condicionar su disponibilidad al estado del barrido (nada de sweep/barrido/isSweeping antes de llamar a analyzeHipOnDemand)", () => {
    // Si algún día se agrega un guard como "if (sweepInProgress) return 409"
    // ANTES de analyzeHipOnDemand en esta ruta puntual, este test debe
    // fallar — es exactamente la regresión que Ramon pidió evitar.
    const beforeCall = manualAnalysisHandler.split("analyzeHipOnDemand(")[0];
    expect(beforeCall).not.toMatch(/sweep|barrido/i);
  });

  test("analyzeHipOnDemand nunca fabrica un resultado cuando no hay foto — lanza NoPhotosError en vez de inventar un score", () => {
    const analyzeFnStart = rankingServiceSrc.indexOf("export async function analyzeHipOnDemand");
    expect(analyzeFnStart).toBeGreaterThanOrEqual(0);
    const fnSrc = rankingServiceSrc.slice(analyzeFnStart, analyzeFnStart + 4000);
    expect(fnSrc).toMatch(/throw new NoPhotosError/);
  });
});

describe("Block 1 — SwiftUI: el botón 'Analizar' no depende del estado del barrido", () => {
  const vmPath = path.join(
    __dirname,
    "../../../RMSelection/ViewModels/HipDetailViewModel.swift"
  );

  // El código Swift vive fuera de `backend/` (repo separado en el
  // dispositivo de Ramon) — en CI (GitHub Actions) solo se hace checkout
  // del repo `rm-selection-backend`, así que el archivo Swift no existe
  // ahí. Este bloque se salta automáticamente en ese caso y sigue
  // corriendo en local cuando ambos repos están disponibles uno al lado
  // del otro (como en este sandbox).
  const swiftAvailable = fs.existsSync(vmPath);
  const maybeTest = swiftAvailable ? test : test.skip;

  maybeTest("needsManualAnalysis() y revealOrAnalyze() no mencionan sweep/barrido", () => {
    const src = fs.readFileSync(vmPath, "utf8");
    const fnStart = src.indexOf("func needsManualAnalysis");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnSrc = src.slice(fnStart, fnStart + 800);
    expect(fnSrc).not.toMatch(/sweep|barrido/i);

    const revealStart = src.indexOf("func revealOrAnalyze");
    expect(revealStart).toBeGreaterThanOrEqual(0);
    const revealSrc = src.slice(revealStart, revealStart + 3000);
    expect(revealSrc).not.toMatch(/sweep|barrido/i);
  });
});
