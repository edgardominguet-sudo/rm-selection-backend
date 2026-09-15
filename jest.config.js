// Configuración de Jest para RM Selection Backend.
//
// PURAMENTE ADITIVO: no modifica `build`/`start`/`dev` ni ningún otro
// script existente — solo agrega la capacidad de correr `npm test`. No
// se toca tsconfig.json (usa su propia config de ts-jest, ver abajo).
//
// Dos proyectos separados a propósito:
//   - "unit": tests puramente de lógica (motor de scoring, geometría,
//     severidad, fechas, fingerprint) — CERO dependencia de Prisma/DB,
//     corren en cualquier entorno (incluso sin acceso de red para
//     descargar el motor de Prisma) y deben ser siempre rápidos y verdes.
//   - "integration": tests que golpean una base Postgres real vía Prisma
//     (rutas de API críticas: Pedigree, Media, Vet Report, Notes,
//     Decision, Favoritos, navegación entre Hips, sincronización). Estos
//     requieren `DATABASE_URL` apuntando a una base de test y el cliente
//     Prisma generado — pensados para correr en CI (ver
//     .github/workflows/test.yml) y opcionalmente en local.
module.exports = {
  projects: [
    {
      displayName: "unit",
      preset: "ts-jest",
      testEnvironment: "node",
      rootDir: __dirname,
      testMatch: ["<rootDir>/tests/unit/**/*.test.ts"],
    },
    {
      displayName: "integration",
      preset: "ts-jest",
      testEnvironment: "node",
      rootDir: __dirname,
      testMatch: ["<rootDir>/tests/integration/**/*.test.ts"],
      setupFilesAfterEnv: ["<rootDir>/tests/integration/setupTestDb.ts"],
      testTimeout: 30000,
    },
  ],
};
