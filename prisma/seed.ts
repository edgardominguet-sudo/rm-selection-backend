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
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
