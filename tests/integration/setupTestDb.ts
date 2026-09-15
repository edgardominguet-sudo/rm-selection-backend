// Setup compartido de los tests de integración — corre antes de CADA
// archivo de test del proyecto "integration" (ver jest.config.js).
//
// Requiere una base Postgres de test real, completamente separada de
// Railway/producción — nunca apunta a la base real. En CI (ver
// .github/workflows/test.yml) esto lo provee un contenedor de servicio
// Postgres efímero; en local, cualquier Postgres de desarrollo con una
// base vacía dedicada sirve (ver README de tests más abajo).
//
// IMPORTANTE: `DATABASE_URL` se fija ACÁ, antes de que cualquier archivo
// de test importe `../../src/db` (que instancia PrismaClient leyendo esa
// variable) — de ahí que esto viva en `setupFilesAfterEnv` en vez de
// dentro de un test individual.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://rmtest:rmtest@localhost:5432/rm_selection_test";
}

// Salvaguarda dura: un typo en la configuración de CI que apunte esta
// suite a una URL de producción (Railway) sería catastrófico — los tests
// de integración crean y BORRAN filas libremente. Todas las URLs de test
// legítimas (locales, contenedor de CI) usan host "localhost"/"postgres"
// (nombre del servicio en docker-compose de GitHub Actions) — cualquier
// otra cosa se rechaza antes de que un solo test llegue a tocar la base.
const url = process.env.DATABASE_URL;
const isKnownSafeTestHost = /^postgresql:\/\/[^@]+@(localhost|127\.0\.0\.1|postgres):/i.test(url);
if (!isKnownSafeTestHost) {
  throw new Error(
    `[tests] DATABASE_URL ("${url}") no parece una base de test local/CI conocida (localhost/postgres). ` +
      `Por seguridad, los tests de integración se niegan a correr contra esto — nunca deben apuntar a Railway/producción.`
  );
}

import { db } from "../../src/db";

afterAll(async () => {
  await db.$disconnect();
});
