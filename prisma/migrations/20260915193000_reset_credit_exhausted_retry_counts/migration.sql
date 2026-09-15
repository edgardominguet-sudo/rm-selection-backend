-- Reset de contador de reintentos afectado por el incidente de saldo de
-- Anthropic agotado (2026-09-15). Confirmado con logs reales de Railway
-- (deployment 39851628, cron de las 3am) que el 100% de una muestra de
-- fallas de autoAnalyzeNewCatalogPhotoIfNeeded ese dia fueron el mismo
-- error "Your credit balance is too low to access the Anthropic API" --
-- antes de la correccion de hoy (ver analysis/autoPhotoAnalysis.ts,
-- AnthropicCreditExhaustedError) ese error SI quemaba el contador de
-- reintentos tecnicos (autoLateralPhotoFailedAttempts) igual que una foto
-- rota, asi que varios Hips sanos quedaron con el tope de 5 alcanzado sin
-- culpa propia, bloqueados para siempre del barrido automatico.
--
-- Con el saldo ya repuesto y el bug corregido, este reset (una sola vez,
-- migracion de datos) le da a esos Hips una oportunidad limpia en el
-- proximo barrido -- SOLO a los que:
--   1) ya agotaron el tope de reintentos (>=5), y
--   2) todavia no tienen ningun CurrentHipAnalysis exitoso (si ya se
--      analizaron bien despues del incidente, no hay nada que tocar).
-- No afecta ningun Hip con foto LATERAL manual, analisis exitoso, ni
-- contador por debajo del tope.
UPDATE "Hip"
SET "autoLateralPhotoFailedAttempts" = 0,
    "autoLateralPhotoLastAttemptedFingerprint" = NULL
WHERE "autoLateralPhotoFailedAttempts" >= 5
  AND NOT EXISTS (
      SELECT 1 FROM "CurrentHipAnalysis" cha WHERE cha."hipId" = "Hip".id
    );
