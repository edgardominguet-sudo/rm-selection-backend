// Helpers compartidos para los tests de integración: arman el mínimo de
// datos reales (Organization → User con apiKey → Device, y Sale → Hip)
// que cualquier ruta protegida por requireUser necesita, y limpian todo
// al final de cada test (delete en cascada desde Sale y Organization —
// ver relaciones onDelete: Cascade en schema.prisma).
import { randomUUID } from "node:crypto";
import { db } from "../../src/db";

export async function createTestOrgAndUser() {
  const organization = await db.organization.create({
    data: { name: `Test Org ${randomUUID()}` },
  });
  const apiKey = `test-key-${randomUUID()}`;
  const user = await db.user.create({
    data: { organizationId: organization.id, apiKey, displayName: "Test User" },
  });
  const device = await db.device.create({
    data: { userId: user.id, platform: "ios", deviceName: "Test iPhone" },
  });
  return { organization, user, apiKey, device };
}

export async function createTestSaleAndHip(overrides: { hipNumber?: string } = {}) {
  const sale = await db.sale.create({
    data: {
      house: "KEENELAND",
      name: `Test Sale ${randomUUID()}`,
      externalSaleId: `test-${randomUUID()}`,
    },
  });
  const hip = await db.hip.create({
    data: {
      saleId: sale.id,
      hipNumber: overrides.hipNumber ?? "1",
      horseName: "Test Colt",
    },
  });
  return { sale, hip };
}

export async function cleanupTestData(ids: { organizationId?: string; saleId?: string }) {
  // Orden defensivo (aunque las cascadas de Prisma ya deberían alcanzar):
  // primero Sale (cascada -> Hip -> UserDecision/HipObservation/
  // PedigreeAnnotation/VetReport/MediaAsset de ese Hip), después
  // Organization (cascada -> User -> Device y las mismas tablas por
  // userId). Envuelto en try/catch individual: un test que ya limpió
  // parte de sus propios datos a mano no debe hacer fallar el afterEach.
  if (ids.saleId) {
    await db.sale.delete({ where: { id: ids.saleId } }).catch(() => {});
  }
  if (ids.organizationId) {
    await db.organization.delete({ where: { id: ids.organizationId } }).catch(() => {});
  }
}
