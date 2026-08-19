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
// de primera generación en esa venta puntual).
//
// CORRECCIÓN 2026-08-19 (REABIERTA): Ramon marcó explícitamente que este
// número NUNCA debía tratarse como límite ni lista cerrada — los 20 de
// arriba eran solo la prueba inicial. Investigué de fuente confiable
// (Hawkstone Bloodstock, artículo del 10 de julio de 2026 sobre la venta
// Fasig-Tipton July) y confirmé que esos 20 coinciden EXACTO con "los
// padrillos de primera generación de yearlings de Kentucky, con fee mayor
// a $5,000, en la venta selecta de FT July 2026" — pero reporté a Ramon
// que esa fuente está acotada (deja afuera padrillos regionales/fuera de
// Kentucky, de fee menor, y todo lo que no llegó a esa venta selecta —
// relevante porque RM Selection también cubre OBS y Keeneland September,
// mucho más grandes que la venta selecta de FT July) y que no encontré
// ninguna fuente única que junte TODOS los debutantes 2026 de las tres
// casas sin ese recorte. Ramon confirmó la lista final agregando estos 7
// nombres de su propio conocimiento del mercado (no de una nota de prensa
// puntual — se documenta acá como "confirmado por Ramon" en vez de
// atribuirle una fuente de prensa que no usé para estos 7): Doppelganger,
// American Revolution, Gufo, Mullion, Paddington, Simplification, Smooth
// Like Strait. Total: 27.
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
  { name: "Doppelganger", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
  { name: "American Revolution", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
  { name: "Gufo", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
  { name: "Mullion", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
  { name: "Paddington", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
  { name: "Simplification", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
  { name: "Smooth Like Strait", source: "Confirmado por Ramon (2026-08-19), lista final de padrillos debutantes 2026" },
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
