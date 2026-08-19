import { PrismaClient } from "@prisma/client";

// Siembra la Organization por defecto (tu equipo) y el usuario "dueño"
// dentro de ella, con la misma clave que ya se usaba como APP_API_KEY —
// así el cambio a autenticación por usuario+organización (ver
// ARCHITECTURE.md §2 y la sección de multi-tenant) no requiere ningún
// cambio del lado de la app: mismo header "x-api-key", mismo valor, pero
// ahora identifica a un User real (con su Organization) en vez de
// compararse contra un secreto suelto.
const db = new PrismaClient();

const DEFAULT_ORGANIZATION_NAME = "RM Selection";

async function main() {
  const apiKey = process.env.APP_API_KEY;
  if (!apiKey) {
    console.warn("APP_API_KEY no está configurada — no se sembró ningún usuario. La API va a quedar abierta sin autenticación hasta que corras el seed con esa variable puesta.");
    return;
  }

  // findFirst en vez de un `key` fijo: hoy hay una sola Organization, pero
  // no se modela como singleton forzado (ver comentario en Organization,
  // schema.prisma) para no tener que migrar el día que haga falta una
  // segunda de verdad.
  let organization = await db.organization.findFirst({ where: { name: DEFAULT_ORGANIZATION_NAME } });
  if (!organization) {
    organization = await db.organization.create({ data: { name: DEFAULT_ORGANIZATION_NAME } });
    console.log(`Organization creada: ${organization.id} (${organization.name})`);
  }

  const user = await db.user.upsert({
    where: { apiKey },
    create: { apiKey, displayName: "Ramon", role: "OWNER", organizationId: organization.id },
    update: { organizationId: organization.id },
  });

  console.log(`Usuario dueño listo: ${user.id} (${user.displayName}) — organización ${organization.id}`);

  await seedFirstYearlingStallions();
}

// "Padrillos de primera generación de yearlings 2026" (2026-08-19, a
// pedido de Ramon) — ver comentario completo del modelo Stallion en
// schema.prisma. Lista COMPILADA A MANO cruzando cobertura de prensa
// especializada (nunca inventada): confirmados por nombre propio como
// "first-crop"/"first sales yearlings" de 2026 en la cobertura de
// Keeneland September 2026 (TDN, BloodHorse/Paulick Report — Keeneland
// declaró 24 padrillos de primera generación en su propio catálogo, de
// los cuales estos son los confirmados por nombre en la prensa) y en la
// venta de julio de Fasig-Tipton 2026 (Hawkstone Bloodstock: 19 padrillos
// de primera generación en esa venta puntual). NO es necesariamente la
// lista completa de los 24 de Keeneland — es un punto de partida
// verificado, ampliable más adelante agregando filas acá (mismo mecanismo,
// sin tocar el resto del código) a medida que se confirmen más nombres.
//
// `source` documenta de dónde salió cada uno, para poder auditar o
// corregir sin re-investigar desde cero (regla de evidencia, instrucciones
// punto 9).
const FIRST_YEARLING_STALLIONS_2026: Array<{ name: string; source: string }> = [
  { name: "Annapolis", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Arabian Lion", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Arcangelo", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Cody's Wish", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Country Grammer", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Dr. Schivel", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Elite Power", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse)" },
  { name: "Forte", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Fulsome", source: "Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Gunite", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Loggins", source: "Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Mage", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Pappacap", source: "Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Proxy", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Rombauer", source: "Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Taiba", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Two Phil's", source: "Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Up to the Mark", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Verifying", source: "Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
  { name: "Zandon", source: "Keeneland September 2026 catalog coverage (TDN/BloodHorse) + Fasig-Tipton July 2026 (Hawkstone Bloodstock)" },
];

async function seedFirstYearlingStallions() {
  for (const stallion of FIRST_YEARLING_STALLIONS_2026) {
    const normalized = stallion.name.trim().replace(/\s+/g, " ").toUpperCase();
    await db.stallion.upsert({
      where: { name: normalized },
      create: { name: normalized, firstYearlingsYear: 2026, source: stallion.source },
      update: { firstYearlingsYear: 2026, source: stallion.source },
    });
  }
  console.log(`Padrillos de primera generación 2026 sembrados: ${FIRST_YEARLING_STALLIONS_2026.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
