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
  await seedStudFees();
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

// Stud Fee 2024/2026 por padrillo (2026-08-25) — investigación completa de
// los 190 padrillos con yearlings en Keeneland September 2026 (8 tandas de
// investigación + segunda verificación, ver keeneland_sept_2026_stud_fees.md
// entregado a Ramon para el detalle completo con fuente por dato). `null` =
// no se encontró ningún dato tras la búsqueda (nunca se inventa un valor).
const STUD_FEES_2026: {
  name: string;
  studFee2024: string | null;
  studFee2026: string | null;
  currentFarm: string | null;
  studFeeSource2024: string | null;
  studFeeSource2026: string | null;
}[] = [
  { name: `Aloha West`, studFee2024: `$8,500 LF`, studFee2026: `$6,500`, currentFarm: `Mill Ridge Farm (KY)`, studFeeSource2024: `Paulick/TDN oficial`, studFeeSource2026: `TDN oficial (Mill Ridge 15-oct-2025)` },
  { name: `Always Dreaming`, studFee2024: `~$5,000–$10,000 (discrepancia)`, studFee2026: `N/A — falleció 10-dic-2024`, currentFarm: `WinStar Farm (histórico)`, studFeeSource2024: `Racing Post/secundarias`, studFeeSource2026: `N/A` },
  { name: `American Pharoah`, studFee2024: `$50,000`, studFee2026: `Sin fee US estándar — shuttle Japón (Shizunai), vuelve a Ashford jul-2026`, currentFarm: `Ashford Stud/Coolmore + Japón`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `TDN oficial 22-oct-2025` },
  { name: `Americanrevolution`, studFee2024: `$12,500 (inaugural)`, studFee2026: `$10,000 LFSN`, currentFarm: `Rockridge Stud (NY)`, studFeeSource2024: `TDN/Paulick oficial`, studFeeSource2026: `rockridgestud.com oficial` },
  { name: `Annapolis`, studFee2024: `$12,500 LFSN`, studFee2026: `$12,500`, currentFarm: `Claiborne Farm (KY)`, studFeeSource2024: `Claiborne oficial/Paulick`, studFeeSource2026: `TDN oficial 15-oct-2025` },
  { name: `Arabian Lion`, studFee2024: `$30,000 S&N (inaugural)`, studFee2026: `$15,000`, currentFarm: `Spendthrift Farm (KY)`, studFeeSource2024: `Paulick/TDN oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Arcangelo`, studFee2024: `$35,000 (inaugural)`, studFee2026: `$30,000 LFSN`, currentFarm: `Lane's End (KY)`, studFeeSource2024: `BloodHorse`, studFeeSource2026: `lanesend.com` },
  { name: `Army Mule`, studFee2024: `$25,000 LFSN`, studFee2026: `$25,000`, currentFarm: `Hill 'n' Dale Farms (KY)`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `TDN oficial` },
  { name: `Audible`, studFee2024: `No confirmado ("TBA" en sitio)`, studFee2026: `$7,500 S&N`, currentFarm: `WinStar Farm (KY)`, studFeeSource2024: `WinStar oficial (sin cifra)`, studFeeSource2026: `búsqueda secundaria` },
  { name: `Authentic`, studFee2024: `$50,000 S&N`, studFee2026: `$15,000`, currentFarm: `Spendthrift Farm (KY)`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Balance the Books`, studFee2024: null, studFee2026: null, currentFarm: `Posiblemente Milky Way/Brandywine Farm (CA)`, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Basin`, studFee2024: `$5,000`, studFee2026: `$5,000`, currentFarm: `Spendthrift Farm (KY)`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Beau Liam`, studFee2024: `$6,000`, studFee2026: `$7,500`, currentFarm: `Airdrie Stud (KY)`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `Airdrie/TDN` },
  { name: `Bee Jersey`, studFee2024: `Private`, studFee2026: `$5,000 S&N`, currentFarm: `Darby Dan Farm (KY)`, studFeeSource2024: `Darby Dan oficial`, studFeeSource2026: `Darby Dan oficial` },
  { name: `Blame`, studFee2024: `$25,000`, studFee2026: `$25,000 (sitio actual dice "TBA")`, currentFarm: `Claiborne Farm (KY)`, studFeeSource2024: `Claiborne oficial`, studFeeSource2026: `TDN oficial 15-oct-2025` },
  { name: `Bolt d'Oro`, studFee2024: `$60,000 S&N`, studFee2026: `$25,000 S&N`, currentFarm: `Spendthrift Farm (KY)`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Brethren`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Bucchero`, studFee2024: null, studFee2026: `$12,500`, currentFarm: `Ironhorse Stallions at Waldorf Farm (NY)`, studFeeSource2024: null, studFeeSource2026: `ironhorsestallions.com oficial` },
  { name: `By My Standards`, studFee2024: `$5,000`, studFee2026: `$5,000`, currentFarm: `Spendthrift Farm (KY)`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Cairo Prince`, studFee2024: `$15,000`, studFee2026: `$10,000`, currentFarm: `Airdrie Stud (KY)`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `TDN "Kentucky Value Sires 2026"` },
  { name: `Candy Ride (ARG)`, studFee2024: null, studFee2026: null, currentFarm: `Lane's End (KY)`, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Caracaro`, studFee2024: null, studFee2026: `$10,000`, currentFarm: `Crestwood Farm (KY)`, studFeeSource2024: null, studFeeSource2026: `TDN "Kentucky Value Sires 2026"` },
  { name: `Catholic Boy`, studFee2024: `$10,000`, studFee2026: null, currentFarm: `Harris Farms (CA) — trasladado desde Claiborne (KY)`, studFeeSource2024: `Claiborne oficial`, studFeeSource2026: null },
  { name: `Charlatan`, studFee2024: `$50,000 LFSN`, studFee2026: `$25,000`, currentFarm: `Hill 'n' Dale Farms (KY)`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `TDN 28-abr-2026` },
  { name: `City of Light`, studFee2024: `$35,000`, studFee2026: `$35,000`, currentFarm: `Lane's End (KY)`, studFeeSource2024: `Lane's End/TDN`, studFeeSource2026: `Lane's End` },
  { name: `Cody's Wish`, studFee2024: `$75,000 (1ra temp)`, studFee2026: `$60,000`, currentFarm: `Darley/Jonabell (KY)`, studFeeSource2024: `Darley/TDN`, studFeeSource2026: `Darley America` },
  { name: `Collected`, studFee2024: `$10,000`, studFee2026: `$7,500`, currentFarm: `DISCREPANCIA: Airdrie vs. Rancho San Miguel CA`, studFeeSource2024: `TrueNicks`, studFeeSource2026: `Airdrie vs. TrueNicks` },
  { name: `Collusion Illusion`, studFee2024: null, studFee2026: `$4,000 CAD`, currentFarm: `Ballycroy Bloodstock (Ontario)`, studFeeSource2024: null, studFeeSource2026: `HRN/TDN` },
  { name: `Colonel Liam`, studFee2024: `$6,500 S&N`, studFee2026: `$6,500 S&N`, currentFarm: `Ocala Stud (FL)`, studFeeSource2024: `TDN/FTBOA`, studFeeSource2026: `Ocala Stud/FTBOA` },
  { name: `Complexity`, studFee2024: `$12,500 (estimado no oficial)`, studFee2026: `$20,000`, currentFarm: `Airdrie Stud (KY)`, studFeeSource2024: `Fuente no oficial`, studFeeSource2026: `Airdrie oficial` },
  { name: `Connect`, studFee2024: null, studFee2026: `DISCREPANCIA: secundaria dice $10,000, ausente en roster oficial`, currentFarm: `Lane's End (histórico) — estatus incierto`, studFeeSource2024: null, studFeeSource2026: `Lane's End roster actual no lo lista` },
  { name: `Constitution`, studFee2024: `$110,000 S&N`, studFee2026: `$110,000`, currentFarm: `WinStar Farm (KY)`, studFeeSource2024: `WinStar/Paulick`, studFeeSource2026: `TDN` },
  { name: `Copper Bullet`, studFee2024: `$7,500 S&N`, studFee2026: null, currentFarm: `CAMBIÓ: Darby Dan→Marjorie Farms TX ($4,000 desde 2025)`, studFeeSource2024: `TDN`, studFeeSource2026: null },
  { name: `Core Beliefs`, studFee2024: null, studFee2026: `$2,500`, currentFarm: `Walmac Farm (KY)`, studFeeSource2024: null, studFeeSource2026: `TDN` },
  { name: `Corniche`, studFee2024: `$25,000`, studFee2026: `$15,000`, currentFarm: `Ashford Stud/Coolmore (KY)`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN/BloodHorse` },
  { name: `Country Grammer`, studFee2024: `$10,000 S&N (intro)`, studFee2026: `$5,000`, currentFarm: `WinStar Farm (KY)`, studFeeSource2024: `WinStar/Paulick`, studFeeSource2026: `WinStar oficial` },
  { name: `Country House`, studFee2024: null, studFee2026: `$5,000`, currentFarm: `Darby Dan Farm (KY)`, studFeeSource2024: null, studFeeSource2026: `Darby Dan/BloodHorse` },
  { name: `Creative Cause`, studFee2024: `$6,000 (1ra temp TX)`, studFee2026: `No reconfirmado ($6,000 en 2025)`, currentFarm: `Marjorie Farms TX (desde Airdrie KY)`, studFeeSource2024: `TDN`, studFeeSource2026: `No confirmado` },
  { name: `Cross Traffic`, studFee2024: `$10,000 S&N`, studFee2026: `$4,000 LFSN`, currentFarm: `CAMBIÓ: Spendthrift→Mt. Airy Farm VA`, studFeeSource2024: `Airdrie/TDN`, studFeeSource2026: `Virginia Equine Alliance` },
  { name: `Curlin`, studFee2024: `$250,000`, studFee2026: `$225,000`, currentFarm: `Hill 'n' Dale at Xalapa (KY)`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `Paulick/TDN` },
  { name: `Cyberknife`, studFee2024: `$25,000 S&N`, studFee2026: `$15,000`, currentFarm: `Spendthrift Farm (KY)`, studFeeSource2024: `TDN`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Daredevil`, studFee2024: null, studFee2026: null, currentFarm: `Lane's End histórico — ausente del roster vigente`, studFeeSource2024: null, studFeeSource2026: `Lane's End roster actual no lo lista` },
  { name: `Demarchelier (GB)`, studFee2024: `TBD al anuncio (no localizado)`, studFee2026: `N/A — vendido para pararse en Brasil`, currentFarm: `Claiborne Farm (KY) hasta 2025 → Brasil desde 2026`, studFeeSource2024: `Claiborne/TDN`, studFeeSource2026: `Claiborne oficial` },
  { name: `Dialed In`, studFee2024: `$15,000 S&N`, studFee2026: `$10,000 S&N`, currentFarm: `Darby Dan Farm (KY)`, studFeeSource2024: `TDN`, studFeeSource2026: `Darby Dan oficial` },
  { name: `Divisidero`, studFee2024: null, studFee2026: `$3,500`, currentFarm: `Airdrie Stud (KY)`, studFeeSource2024: null, studFeeSource2026: `Airdrie oficial` },
  { name: `Doppelganger`, studFee2024: `$10,000 LFSN (1ra temp)`, studFee2026: null, currentFarm: `Pleasant Acres Stallions (FL)`, studFeeSource2024: `TDN`, studFeeSource2026: null },
  { name: `Dr. Schivel`, studFee2024: `$12,500 S&N (1ra temp)`, studFee2026: null, currentFarm: `Taylor Made Stallions (KY)`, studFeeSource2024: `TDN`, studFeeSource2026: null },
  { name: `Drain the Clock`, studFee2024: null, studFee2026: null, currentFarm: `Gainesway (KY)`, studFeeSource2024: null, studFeeSource2026: `Gainesway oficial (no legible)` },
  { name: `Early Voting`, studFee2024: `$20,000`, studFee2026: `$12,500`, currentFarm: `Taylor Made Stallions KY (movido desde Ashford 2024)`, studFeeSource2024: `TDN`, studFeeSource2026: `Taylor Made` },
  { name: `Echo Town`, studFee2024: `$5,000 (Ashford)`, studFee2026: `$3,500`, currentFarm: `Leadem Farm, Arkansas (movido desde Ashford 2026)`, studFeeSource2024: `TrueNicks/BloodHorse`, studFeeSource2026: `TDN` },
  { name: `Elite Power`, studFee2024: `$50,000`, studFee2026: `$35,000`, currentFarm: `Juddmonte KY`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN/Juddmonte oficial` },
  { name: `Enticed`, studFee2024: `$5,000`, studFee2026: `$5,000`, currentFarm: `Mountain Springs Farm PA (movido desde Darley/Jonabell 2025)`, studFeeSource2024: `TrueNicks`, studFeeSource2026: `enticedpa.com oficial` },
  { name: `Epicenter`, studFee2024: `$40,000`, studFee2026: `$25,000`, currentFarm: `Ashford Stud KY`, studFeeSource2024: `BloodHorse/DRF`, studFeeSource2026: `Paulick oficial` },
  { name: `Essential Quality`, studFee2024: `$65,000`, studFee2026: `$25,000`, currentFarm: `Darley America (Jonabell) KY`, studFeeSource2024: `TrueNicks`, studFeeSource2026: `BloodHorse/TDN` },
  { name: `Flameaway`, studFee2024: `$15,000 S&N`, studFee2026: `$10,000 S&N`, currentFarm: `Darby Dan Farm KY`, studFeeSource2024: `Darby Dan oficial`, studFeeSource2026: `Darby Dan oficial` },
  { name: `Flightline`, studFee2024: `$150,000`, studFee2026: `$125,000`, currentFarm: `Lane's End KY`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `TDN oficial` },
  { name: `Forte`, studFee2024: `$50,000 S&N`, studFee2026: `$35,000 S&N`, currentFarm: `Spendthrift Farm KY`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Frosted`, studFee2024: `$10,000`, studFee2026: `$12,500`, currentFarm: `Darley America (Jonabell) KY`, studFeeSource2024: `TrueNicks`, studFeeSource2026: `TDN` },
  { name: `Fulsome`, studFee2024: `$7,500 S&N`, studFee2026: `$7,500 S&N`, currentFarm: `Walmac Farm KY`, studFeeSource2024: `TDN/Paulick oficial`, studFeeSource2026: `Walmac oficial` },
  { name: `Galilean`, studFee2024: `$3,000`, studFee2026: `$3,500`, currentFarm: `Questroyal North (antes Hidden Lake Farm) NY`, studFeeSource2024: `BloodHorse`, studFeeSource2026: `Questroyal North` },
  { name: `Game Winner`, studFee2024: `$20,000 LFSN`, studFee2026: `$20,000 (también shuttle Brasil)`, currentFarm: `Lane's End KY`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `Lane's End/BloodHorse` },
  { name: `Ghostzapper`, studFee2024: `$75,000 LFSN`, studFee2026: `Pensionado — sin monta 2026`, currentFarm: `Adena Springs North, Ontario (retirado)`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `TDN` },
  { name: `Girvin`, studFee2024: `$30,000`, studFee2026: `$30,000`, currentFarm: `Airdrie Stud KY`, studFeeSource2024: `TDN/Airdrie oficial`, studFeeSource2026: `Airdrie oficial` },
  { name: `Global Campaign`, studFee2024: `$12,500`, studFee2026: `Privada (Corea del Sur)`, currentFarm: `Jeong Seong Farm, Corea del Sur (desde WinStar 2026)`, studFeeSource2024: `WinStar oficial`, studFeeSource2026: `Paulick` },
  { name: `Golden Pal`, studFee2024: `$25,000`, studFee2026: `$25,000`, currentFarm: `Ashford Stud KY`, studFeeSource2024: `BloodHorse/TDN`, studFeeSource2026: `Paulick oficial` },
  { name: `Goldencents`, studFee2024: `$10,000 S&N`, studFee2026: `$10,000 S&N`, currentFarm: `Spendthrift Farm KY`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Good Magic`, studFee2024: `$125,000 LFSN`, studFee2026: `$125,000`, currentFarm: `Hill 'n' Dale at Xalapa KY`, studFeeSource2024: `Paulick oficial`, studFeeSource2026: `TDN` },
  { name: `Good Samaritan`, studFee2024: `$5,000`, studFee2026: `Privada (Chile)`, currentFarm: `Haras Mocito Guapo, Chile`, studFeeSource2024: `WinStar oficial`, studFeeSource2026: `TDN` },
  { name: `Greatest Honour`, studFee2024: `$7,500 S&N`, studFee2026: `$7,500 S&N (Safe Bet)`, currentFarm: `Spendthrift Farm KY`, studFeeSource2024: `Spendthrift oficial`, studFeeSource2026: `Spendthrift oficial` },
  { name: `Gufo`, studFee2024: `CAN$4,500 (~US$3,300)`, studFee2026: `$5,000 S&N`, currentFarm: `Darby Dan Farm KY (desde Ballycroy Ontario 2025)`, studFeeSource2024: `BloodHorse`, studFeeSource2026: `Darby Dan oficial` },
  { name: `Gun Runner`, studFee2024: `$250,000 LFSN`, studFee2026: `$250,000 LFSN`, currentFarm: `Three Chimneys Farm KY`, studFeeSource2024: `Three Chimneys oficial`, studFeeSource2026: `Three Chimneys oficial` },
  { name: `Gunite`, studFee2024: `$35,000`, studFee2026: `$25,000`, currentFarm: `Ashford Stud KY`, studFeeSource2024: `TDN oficial`, studFeeSource2026: `Paulick oficial` },
  { name: `Happy Saver`, studFee2024: `$10,000`, studFee2026: `$7,500 S&N`, currentFarm: `Airdrie Stud`, studFeeSource2024: `airdriestud.com`, studFeeSource2026: `airdriestud.com` },
  { name: `Hard Spun`, studFee2024: `$35,000`, studFee2026: `$20,000`, currentFarm: `Darley America (Jonabell)`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Higher Power`, studFee2024: `$10,000 S&N`, studFee2026: `$2,000 LFSN`, currentFarm: `R.C. Cline Thoroughbred Farm OH (desde Darby Dan KY)`, studFeeSource2024: `darbydan.com`, studFeeSource2026: `BloodHorse` },
  { name: `Highly Motivated`, studFee2024: `$7,500`, studFee2026: `$7,500 S&N`, currentFarm: `Airdrie Stud`, studFeeSource2024: `airdriestud.com`, studFeeSource2026: `airdriestud.com` },
  { name: `Honest Mischief`, studFee2024: `$6,500 LFSN`, studFee2026: `$7,500 LFSN`, currentFarm: `Sequel Stallions New York`, studFeeSource2024: `nytbreeders.org`, studFeeSource2026: `TDN/Paulick` },
  { name: `Honor A. P.`, studFee2024: `$10,000`, studFee2026: `$7,500`, currentFarm: `Lane's End`, studFeeSource2024: `Paulick`, studFeeSource2026: `TDN` },
  { name: `Idol`, studFee2024: `$10,000`, studFee2026: `$5,000 S&N`, currentFarm: `Taylor Made Stallions`, studFeeSource2024: `Paulick/TDN`, studFeeSource2026: `taylormadestallions.com` },
  { name: `Improbable`, studFee2024: `$15,000 S&N`, studFee2026: `N/A — falleció 16-mar-2024`, currentFarm: `WinStar Farm (fallecido)`, studFeeSource2024: `winstarfarm.com`, studFeeSource2026: null },
  { name: `Independence Hall`, studFee2024: `$10,000`, studFee2026: `$10,000* (sujeto a Breeders' Cup)`, currentFarm: `WinStar Farm`, studFeeSource2024: `winstarfarm.com`, studFeeSource2026: `winstarfarm.com` },
  { name: `Instagrand`, studFee2024: `$7,500`, studFee2026: `$8,000 S&N`, currentFarm: `Taylor Made Stallions`, studFeeSource2024: `Paulick/TDN`, studFeeSource2026: `taylormadestallions.com` },
  { name: `Into Mischief`, studFee2024: `$250,000 S&N`, studFee2026: `$250,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Isotherm`, studFee2024: `$1,500`, studFee2026: `$1,500 S&N`, currentFarm: `Swifty Farms, IN`, studFeeSource2024: `registro Indiana`, studFeeSource2026: `mismo` },
  { name: `Jack Christopher`, studFee2024: `$40,000`, studFee2026: `$15,000`, currentFarm: `Ashford Stud (Coolmore)`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN` },
  { name: `Jackie's Warrior`, studFee2024: `$45,000 S&N`, studFee2026: `$25,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Jimmy Creed`, studFee2024: `$10,000 S&N`, studFee2026: `$7,500 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Justify`, studFee2024: `$200,000 LFSN`, studFee2026: `$200,000`, currentFarm: `Ashford Stud (Coolmore)`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN` },
  { name: `Kantharos`, studFee2024: `$15,000`, studFee2026: `$10,000 LFSN`, currentFarm: `Hill 'n' Dale Farms`, studFeeSource2024: `Paulick`, studFeeSource2026: `hillndalefarms.com` },
  { name: `Karakontie (JPN)`, studFee2024: `$15,000 LFSN`, studFee2026: `$15,000`, currentFarm: `Gainesway`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `TDN` },
  { name: `Keen Ice`, studFee2024: `$7,500`, studFee2026: `$7,500 LFSN`, currentFarm: `Calumet Farm`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `calumetfarm.com` },
  { name: `Keepmeinmind`, studFee2024: `$6,500 LFSN`, studFee2026: `$2,000–2,500`, currentFarm: `Whispering Oaks Farm LA (desde Sequel NY)`, studFeeSource2024: `BloodHorse/Paulick`, studFeeSource2026: `agregado` },
  { name: `King for a Day`, studFee2024: `$5,000 LFSN`, studFee2026: `$5,000 LFSN`, currentFarm: `Irish Hill Century Farm NY`, studFeeSource2024: `BloodHorse`, studFeeSource2026: `irishhillcenturyfarm.com` },
  { name: `Knicks Go`, studFee2024: `$15,000 S&N`, studFee2026: `Privada — reubicado a Corea del Sur`, currentFarm: `Taylor Made (2024) → KRA Corea (2026)`, studFeeSource2024: `Paulick/TDN`, studFeeSource2026: `BloodHorse` },
  { name: `Known Agenda`, studFee2024: `$7,500 S&N`, studFee2026: `$5,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Lexitonian`, studFee2024: `$7,500 LF`, studFee2026: `$7,500 LFSN`, currentFarm: `Calumet Farm`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `calumetfarm.com` },
  { name: `Liam's Map`, studFee2024: `$40,000 LFSN`, studFee2026: `$50,000`, currentFarm: `Lane's End`, studFeeSource2024: `Paulick`, studFeeSource2026: `Paulick` },
  { name: `Life Is Good`, studFee2024: `$85,000 S&N`, studFee2026: `$60,000 S&N`, currentFarm: `WinStar Farm`, studFeeSource2024: `winstarfarm.com`, studFeeSource2026: `winstarfarm.com` },
  { name: `Loggins`, studFee2024: `$7,500 LFSN`, studFee2026: `$5,000 LFSN`, currentFarm: `Hill 'n' Dale at Xalapa`, studFeeSource2024: `Paulick`, studFeeSource2026: `TDN` },
  { name: `Lope de Vega (IRE)`, studFee2024: `€125,000`, studFee2026: `€200,000`, currentFarm: `Ballylinch Stud, Irlanda`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN` },
  { name: `Maclean's Music`, studFee2024: `$40,000 LFSN`, studFee2026: `$30,000 LFSN`, currentFarm: `Hill 'n' Dale at Xalapa`, studFeeSource2024: `Paulick`, studFeeSource2026: `hillndalefarms.com/TDN` },
  { name: `Mage`, studFee2024: `$25,000 (1ra temp)`, studFee2026: `$15,000`, currentFarm: `Airdrie Stud`, studFeeSource2024: `BloodHorse/Paulick`, studFeeSource2026: `airdriestud.com` },
  { name: `Mandaloun`, studFee2024: `$20,000 LFSN`, studFee2026: `$10,000 LFSN`, currentFarm: `Juddmonte USA`, studFeeSource2024: `stallions.juddmonte.com`, studFeeSource2026: `stallions.juddmonte.com` },
  { name: `Maxfield`, studFee2024: `$35,000`, studFee2026: `$50,000`, currentFarm: `Darley America/Jonabell`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Maximum Security`, studFee2024: `$7,500`, studFee2026: `$3,500`, currentFarm: `Breakaway Farm, Indiana (desde Ashford KY)`, studFeeSource2024: `Equibase secundaria`, studFeeSource2026: `Paulick/BloodHorse/DRF` },
  { name: `Maximus Mischief`, studFee2024: `$25,000 S&N`, studFee2026: `$20,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `McKinzie`, studFee2024: `$30,000`, studFee2026: `$75,000* (sujeto a Breeders' Cup)`, currentFarm: `Gainesway`, studFeeSource2024: `TDN`, studFeeSource2026: `gainesway.com` },
  { name: `Medaglia d'Oro`, studFee2024: `$75,000`, studFee2026: `Retirado del roster (pensionado)`, currentFarm: `Darley America/Jonabell`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Mendelssohn`, studFee2024: `$15,000`, studFee2026: `Privada/no publicado`, currentFarm: `Haras Don Alberto, Chile (desde Ashford KY)`, studFeeSource2024: `TDN`, studFeeSource2026: `BloodHorse` },
  { name: `Midnight Lute`, studFee2024: `$10,000 LFSN`, studFee2026: `Pensionado (abril 2025)`, currentFarm: `Hill 'n' Dale (fue)`, studFeeSource2024: `Paulick`, studFeeSource2026: `BloodHorse Register` },
  { name: `Midshipman`, studFee2024: `$15,000`, studFee2026: `$15,000`, currentFarm: `Darley America/Jonabell`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Mind Control`, studFee2024: `$8,500 LFSN`, studFee2026: `$6,000 LFSN`, currentFarm: `Irish Hill & Dutchess Views (Rockridge Stud NY)`, studFeeSource2024: `nytbreeders.org`, studFeeSource2026: `irishhillcenturyfarm.com` },
  { name: `Mineshaft`, studFee2024: `$10,000 LFSN`, studFee2026: `Pensionado (abril 2025)`, currentFarm: `Lane's End`, studFeeSource2024: `Paulick`, studFeeSource2026: `lanesend.com` },
  { name: `Mitole`, studFee2024: `$15,000 S&N`, studFee2026: `$10,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `Paulick/TDN`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Mo Donegal`, studFee2024: `$15,000 S&N`, studFee2026: `$5,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Mo Town`, studFee2024: `$5,000`, studFee2026: `$7,500`, currentFarm: `Ashford Stud/Coolmore`, studFeeSource2024: `Paulick secundaria`, studFeeSource2026: `Coolmore secundaria` },
  { name: `Modernist`, studFee2024: `$10,000 S&N`, studFee2026: `$5,000 S&N`, currentFarm: `Darby Dan Farm`, studFeeSource2024: `Paulick`, studFeeSource2026: `darbydan.com` },
  { name: `Mr Speaker`, studFee2024: null, studFee2026: `Privada`, currentFarm: `Forks of the Paluxy Farm, TX`, studFeeSource2024: null, studFeeSource2026: `BloodHorse Register` },
  { name: `Mullion`, studFee2024: `TBA/Privada (sitio actual)`, studFee2026: `$5,000 LFSN`, currentFarm: `Sequel Stallions New York`, studFeeSource2024: `sequelnewyork.com`, studFeeSource2026: `BloodHorse Register` },
  { name: `Munnings`, studFee2024: `$75,000`, studFee2026: `$45,000`, currentFarm: `Ashford Stud/Coolmore`, studFeeSource2024: `TDN/Racing Post`, studFeeSource2026: `coolmore.com` },
  { name: `Mystic Guide`, studFee2024: `$12,500`, studFee2026: `$7,500`, currentFarm: `Darley America (Jonabell)`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Nashville`, studFee2024: `$15,000`, studFee2026: `$12,500`, currentFarm: `WinStar Farm`, studFeeSource2024: `winstarfarm.com`, studFeeSource2026: `winstarfarm.com` },
  { name: `Not This Time`, studFee2024: `$150,000`, studFee2026: `$250,000`, currentFarm: `Taylor Made Stallions`, studFeeSource2024: `Paulick/TDN`, studFeeSource2026: `BloodHorse/TDN` },
  { name: `Nyquist`, studFee2024: `$85,000`, studFee2026: `$175,000`, currentFarm: `Darley America (Jonabell)`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `BloodHorse` },
  { name: `Olympiad`, studFee2024: null, studFee2026: null, currentFarm: `Gainesway (confirmado)`, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Omaha Beach`, studFee2024: null, studFee2026: `$75,000`, currentFarm: `Spendthrift Farm`, studFeeSource2024: null, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Oscar Performance`, studFee2024: null, studFee2026: `$60,000 LF`, currentFarm: `Mill Ridge Farm`, studFeeSource2024: null, studFeeSource2026: `millridge.com` },
  { name: `Outwork`, studFee2024: `$10,000`, studFee2026: `Ausente del roster 2026 de WinStar`, currentFarm: `WinStar (2024); estatus 2026 sin confirmar`, studFeeSource2024: `winstarfarm.com`, studFeeSource2026: `winstarfarm.com (ausente)` },
  { name: `Paddington (GB)`, studFee2024: `~€55,000 (no verificado directo)`, studFee2026: `~€20,000 (no verificado directo)`, currentFarm: `Coolmore Irlanda`, studFeeSource2024: `No confirmado`, studFeeSource2026: `No confirmado` },
  { name: `Pappacap`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Pinehurst`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Practical Joke`, studFee2024: null, studFee2026: `$75,000`, currentFarm: `Ashford Stud/Coolmore`, studFeeSource2024: null, studFeeSource2026: `coolmore.com` },
  { name: `Preservationist`, studFee2024: null, studFee2026: `N/A — probable fallecido`, currentFarm: `Airdrie Stud (histórico)`, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Proxy`, studFee2024: `$25,000`, studFee2026: `$12,500`, currentFarm: `Darley America (Jonabell)`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Quality Road`, studFee2024: null, studFee2026: null, currentFarm: `Lane's End Farm (confirmado)`, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Roadster`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Rock Your World`, studFee2024: `$7,500`, studFee2026: `$7,500`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Rowayton`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Runhappy`, studFee2024: null, studFee2026: `N/A — vendido a Corea del Sur`, currentFarm: `Claiborne (hasta 2025) → Corea del Sur (2026)`, studFeeSource2024: null, studFeeSource2026: `Claiborne/Paulick` },
  { name: `Scalding`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Seeking the Soul`, studFee2024: null, studFee2026: `N/A — falleció 28-feb-2025`, currentFarm: null, studFeeSource2024: null, studFeeSource2026: `Wikipedia` },
  { name: `Shancelot`, studFee2024: `$5,000 LFSN`, studFee2026: `$5,000 LFSN (sin etiqueta "2026" explícita)`, currentFarm: `Buck Pond Farm, Versailles KY`, studFeeSource2024: `buckpondfarm.com oficial`, studFeeSource2026: `shancelotbookings.com (sitio oficial reservas, sin año explícito)` },
  { name: `Silver State`, studFee2024: null, studFee2026: `$7,500`, currentFarm: `Claiborne Farm`, studFeeSource2024: null, studFeeSource2026: `Claiborne oficial` },
  { name: `Simplification`, studFee2024: null, studFee2026: null, currentFarm: null, studFeeSource2024: null, studFeeSource2026: null },
  { name: `Sir Winston`, studFee2024: `$7,500 LFSN`, studFee2026: `$5,000 LFSN`, currentFarm: `Crestwood Farm`, studFeeSource2024: `TDN`, studFeeSource2026: `crestwoodfarm.com` },
  { name: `Slumber (GB)`, studFee2024: null, studFee2026: null, currentFarm: `Rockridge Stud NY`, studFeeSource2024: null, studFeeSource2026: `rockridgestud.com (sin fee)` },
  { name: `Smooth Like Strait`, studFee2024: `$3,500 LF (1ra temp)`, studFee2026: `$3,500 LFG`, currentFarm: `War Horse Place KY (2024) → Eclipse Thoroughbred Farm CA (2026)`, studFeeSource2024: `TDN`, studFeeSource2026: `Paulick oficial` },
  { name: `Social Inclusion`, studFee2024: null, studFee2026: `Privada`, currentFarm: `Briardale Farm, FL`, studFeeSource2024: null, studFeeSource2026: `Paulick/TrueNicks` },
  { name: `Solomini`, studFee2024: `$7,500 LF`, studFee2026: `$7,500 LFSN`, currentFarm: `McMahon of Saratoga Thoroughbreds NY`, studFeeSource2024: `TDN`, studFeeSource2026: `mcmahonthoroughbreds.com` },
  { name: `Speaker's Corner`, studFee2024: `$17,500`, studFee2026: `$10,000`, currentFarm: `Darley/Jonabell`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Spun to Run`, studFee2024: null, studFee2026: `Ausente del roster oficial Gainesway 2026 vs. secundaria $10,000`, currentFarm: `Gainesway Farm`, studFeeSource2024: null, studFeeSource2026: `Gainesway oficial (ausente) vs. secundaria` },
  { name: `St Mark's Basilica (FR)`, studFee2024: `€50,000`, studFee2026: `€40,000`, currentFarm: `Coolmore Stud, Irlanda`, studFeeSource2024: `Racing Post/Montjeu`, studFeeSource2026: `TDN` },
  { name: `St Patrick's Day`, studFee2024: `$3,500 S&N`, studFee2026: `Privada`, currentFarm: `Journeyman Stud FL (2024) → Summer Wind Farm FL (2026)`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN/BloodHorse` },
  { name: `Starspangledbanner (AUS)`, studFee2024: `€45,000`, studFee2026: `€60,000`, currentFarm: `Coolmore Stud, Irlanda`, studFeeSource2024: `Breednet`, studFeeSource2026: `TDN` },
  { name: `Street Sense`, studFee2024: `$60,000`, studFee2026: `$40,000`, currentFarm: `Darley/Jonabell`, studFeeSource2024: `darleyamerica.com`, studFeeSource2026: `darleyamerica.com` },
  { name: `Tacitus`, studFee2024: `$10,000 S&N`, studFee2026: `$5,000 S&N`, currentFarm: `Taylor Made Stallions`, studFeeSource2024: `TrueNicks`, studFeeSource2026: `taylormadestallions.com` },
  { name: `Taiba`, studFee2024: `$35,000 S&N (intro)`, studFee2026: `$25,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `spendthriftfarm.com`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Take Charge Indy`, studFee2024: `$10,000`, studFee2026: `$7,500 S&N`, currentFarm: `WinStar Farm`, studFeeSource2024: `TDN`, studFeeSource2026: `winstarfarm.com` },
  { name: `Tale of Ekati`, studFee2024: `Privada`, studFee2026: `$5,000 S&N`, currentFarm: `Darby Dan Farm`, studFeeSource2024: `TDN`, studFeeSource2026: `darbydan.com` },
  { name: `Tale of Silence`, studFee2024: `$2,500 (aprox. estable)`, studFee2026: `$2,500 CAD`, currentFarm: `Darby Dan KY (2024) → Colebrook Stallion Station Ontario (2026)`, studFeeSource2024: `darbydan.com`, studFeeSource2026: `TDN` },
  { name: `Tapit`, studFee2024: `$185,000`, studFee2026: `$185,000`, currentFarm: `Gainesway`, studFeeSource2024: `gainesway.com`, studFeeSource2026: `gainesway.com` },
  { name: `Tapiture`, studFee2024: `$7,500`, studFee2026: `$6,000 CAD`, currentFarm: `Darby Dan KY (2024) → Highfield Stock Farm Alberta (2026)`, studFeeSource2024: `TDN`, studFeeSource2026: `TDN` },
  { name: `Tapwrit`, studFee2024: `$7,500`, studFee2026: `$2,500 LF`, currentFarm: `Gainesway KY (2024) → Indiana Stallion Station (2025-26)`, studFeeSource2024: `Paulick/DRF`, studFeeSource2026: `Paulick/BloodHorse` },
  { name: `Temple City`, studFee2024: null, studFee2026: `Privada`, currentFarm: `Spendthrift Farm`, studFeeSource2024: null, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Ten Sovereigns (IRE)`, studFee2024: `€17,500`, studFee2026: `Turquía; fee no público`, currentFarm: `Coolmore Irlanda (2024) → Celikoglu Stud Turquía (2025-)`, studFeeSource2024: `Racing Post/Montjeu`, studFeeSource2026: `TDN` },
  { name: `Thousand Words`, studFee2024: `$5,000 S&N`, studFee2026: `$7,500 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `TDN/BloodHorse`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Title Ready`, studFee2024: null, studFee2026: `$2,000 LF`, currentFarm: `Darby Dan KY (2024) → Breakaway Farm Indiana (2026)`, studFeeSource2024: null, studFeeSource2026: `Paulick/Yahoo Sports` },
  { name: `Tiz the Law`, studFee2024: `$20,000`, studFee2026: `$40,000`, currentFarm: `Ashford Stud (Coolmore)`, studFeeSource2024: `TDN/Paulick`, studFeeSource2026: `BloodHorse/TDN` },
  { name: `Tom's d'Etat`, studFee2024: `$7,500 S&N`, studFee2026: `Privada (trasladado a Red River Farms LA feb-2026)`, currentFarm: `Red River Farms LA (era WinStar KY)`, studFeeSource2024: `Paulick/WinStar`, studFeeSource2026: `BloodHorse/TDN` },
  { name: `Twirling Candy`, studFee2024: `$60,000`, studFee2026: `$75,000`, currentFarm: `Lane's End`, studFeeSource2024: `Paulick/TDN`, studFeeSource2026: `lanesend.com` },
  { name: `Two Phil's`, studFee2024: `$12,500 S&N (intro)`, studFee2026: `$7,500 S&N`, currentFarm: `WinStar Farm`, studFeeSource2024: `WinStar/Paulick`, studFeeSource2026: `winstarfarm.com` },
  { name: `Uncle Mo`, studFee2024: `$150,000`, studFee2026: `N/A — falleció 19-dic-2024`, currentFarm: `(era Ashford Stud/Coolmore)`, studFeeSource2024: `BloodHorse`, studFeeSource2026: `Coolmore/TDN` },
  { name: `Up to the Mark`, studFee2024: `$25,000 LFSN (intro)`, studFee2026: `$25,000 LFSN`, currentFarm: `Lane's End`, studFeeSource2024: `Paulick/HRN`, studFeeSource2026: `lanesend.com` },
  { name: `Upstart`, studFee2024: `$30,000`, studFee2026: `$25,000`, currentFarm: `Airdrie Stud`, studFeeSource2024: `Paulick`, studFeeSource2026: `airdriestud.com` },
  { name: `Valiant Minister`, studFee2024: `$4,000`, studFee2026: `$3,500`, currentFarm: `Bridlewood Farm`, studFeeSource2024: `BloodHorse`, studFeeSource2026: `bridlewoodfarm.com` },
  { name: `Vekoma`, studFee2024: `$15,000 S&N (intro)`, studFee2026: `$100,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `Paulick/BloodHorse`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Verifying`, studFee2024: `$10,000 S&N (intro)`, studFee2026: `$10,000 S&N`, currentFarm: `Pleasant Acres Stallions FL`, studFeeSource2024: `Paulick`, studFeeSource2026: `pleasantacresstallions.com` },
  { name: `Vino Rosso`, studFee2024: `$20,000 S&N`, studFee2026: `$7,500 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `Spendthrift/BloodHorse`, studFeeSource2026: `spendthriftfarm.com` },
  { name: `Violence`, studFee2024: `$40,000 LF`, studFee2026: `$30,000 LFSN`, currentFarm: `Hill 'n' Dale Farms`, studFeeSource2024: `BloodHorse/DRF`, studFeeSource2026: `hillndalefarms.com` },
  { name: `Volatile`, studFee2024: `$15,000`, studFee2026: `$10,000 LFSN`, currentFarm: `Three Chimneys Farm`, studFeeSource2024: `Fuente secundaria (TDN roundup)`, studFeeSource2026: `threechimneys.com` },
  { name: `War Front`, studFee2024: `$100,000`, studFee2026: `Privada (última temporada, se retira tras 2026)`, currentFarm: `Claiborne Farm`, studFeeSource2024: `Racing Post/Claiborne`, studFeeSource2026: `BloodHorse` },
  { name: `War of Will`, studFee2024: `$25,000`, studFee2026: `$5,000 "early bird"`, currentFarm: `Rockridge Stud NY (desde Claiborne)`, studFeeSource2024: `Claiborne Farm`, studFeeSource2026: `BloodHorse` },
  { name: `Warrior's Charge`, studFee2024: `$5,000 (intro)`, studFee2026: `$5,000 LFSN`, currentFarm: `Irish Hill & Dutchess Views Stallions NY`, studFeeSource2024: `nybreds.com`, studFeeSource2026: `ihdvstallions.com` },
  { name: `Win Win Win`, studFee2024: `$5,000`, studFee2026: `$8,500 S&N`, currentFarm: `Ocala Stud`, studFeeSource2024: `Paulick`, studFeeSource2026: `ftboa.com` },
  { name: `Without Parole (GB)`, studFee2024: `£8,000`, studFee2026: `£10,000`, currentFarm: `Newsells Park Stud UK`, studFeeSource2024: `TDN`, studFeeSource2026: `newsells-park.com` },
  { name: `Wootton Bassett (GB)`, studFee2024: `€200,000`, studFee2026: `N/A — falleció`, currentFarm: `(era Coolmore Irlanda/Australia)`, studFeeSource2024: `Racing Post/TDN`, studFeeSource2026: `Falleció 23-sep-2025` },
  { name: `World of Trouble`, studFee2024: `$5,000 (última temp KY)`, studFee2026: `N/A en EE.UU. — vendido a Brasil`, currentFarm: `Haras Rio Iguassú Brasil (era Hill 'n' Dale KY)`, studFeeSource2024: `Fuente secundaria`, studFeeSource2026: `TDN` },
  { name: `Yaupon`, studFee2024: `$25,000 S&N`, studFee2026: `$60,000 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `Spendthrift`, studFeeSource2026: `TDN` },
  { name: `Yorkton`, studFee2024: null, studFee2026: `$5,000 CAD`, currentFarm: `Adena Springs North Ontario (desde Crestwood KY)`, studFeeSource2024: `Crestwood (sin fee 2024)`, studFeeSource2026: `Paulick` },
  { name: `Zandon`, studFee2024: `$12,500 S&N (intro)`, studFee2026: `$7,500 S&N`, currentFarm: `Spendthrift Farm`, studFeeSource2024: `Paulick/BloodHorse`, studFeeSource2026: `spendthriftfarm.com` },
];

async function seedStudFees() {
  let updated = 0;
  for (const entry of STUD_FEES_2026) {
    const normalized = entry.name.trim().replace(/\s+/g, " ").toUpperCase();
    await db.stallion.upsert({
      where: { name: normalized },
      create: {
        name: normalized,
        studFee2024: entry.studFee2024,
        studFee2026: entry.studFee2026,
        currentFarm: entry.currentFarm,
        studFeeSource2024: entry.studFeeSource2024,
        studFeeSource2026: entry.studFeeSource2026,
      },
      update: {
        studFee2024: entry.studFee2024,
        studFee2026: entry.studFee2026,
        currentFarm: entry.currentFarm,
        studFeeSource2024: entry.studFeeSource2024,
        studFeeSource2026: entry.studFeeSource2026,
      },
    });
    updated++;
  }
  console.log(`Stud Fees 2024/2026 sembrados: ${updated}`);
}

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
