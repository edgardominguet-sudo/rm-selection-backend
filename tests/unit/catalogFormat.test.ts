import { canonicalizeNormalizedHip, canonicalColor, canonicalSex } from "../../src/catalogFormat";
import { parseKeenelandCatalogIds } from "../../src/saleHouses/keenelandCatalogIds";
import { NormalizedHip } from "../../src/types";

function hip(partial: Partial<NormalizedHip>): NormalizedHip {
  return { hipNumber: "1", media: [], ...partial };
}

describe("formato único de catálogo (todas las casas)", () => {
  it("Keeneland queda con el formato de Fasig-Tipton", () => {
    const out = canonicalizeNormalizedHip(
      hip({
        horseName: "Crazy Hot Mess",
        sex: "F",
        sire: "Pinehurst",
        dam: "Pure  Moon",
        damSire: "Malibu Moon",
        consignor: "Taylor Made Sales Agency, Agent II ",
        color: "Dark Bay/Brown",
      })
    );
    expect(out).toMatchObject({
      horseName: "CRAZY HOT MESS",
      sex: "F",
      sire: "PINEHURST",
      dam: "PURE MOON",
      damSire: "MALIBU MOON",
      consignor: "TAYLOR MADE SALES AGENCY, AGENT II",
      color: "Dark Bay/Brown",
    });
  });

  it("caballo sin nombre: AÑO-MADRE como Fasig-Tipton", () => {
    expect(canonicalizeNormalizedHip(hip({ horseName: "Hip 0001", dam: "Racing", foalYear: 2025 })).horseName).toBe("2025-RACING");
    expect(
      canonicalizeNormalizedHip(hip({ horseName: undefined, dam: "Alexa Lou", foalingDate: new Date("2026-03-01T12:00:00Z") })).horseName
    ).toBe("2026-ALEXA LOU");
    // Sin año no se inventa nada.
    expect(canonicalizeNormalizedHip(hip({ horseName: "Hip 12", dam: "X" })).horseName).toBe("HIP 12");
  });

  it("colores de cualquier casa al juego canónico de la app", () => {
    expect(canonicalColor("CH")).toBe("Chestnut");
    expect(canonicalColor("DK B/")).toBe("Dark Bay/Brown");
    expect(canonicalColor("Gray/Roan")).toBe("Gray/Roan");
    expect(canonicalColor("B")).toBe("Bay");
    expect(canonicalColor("Palomino")).toBe("PALOMINO"); // desconocido: se conserva
    expect(canonicalColor("  ")).toBeUndefined();
  });

  it("sexo siempre en código de una letra", () => {
    expect(canonicalSex("Colt")).toBe("C");
    expect(canonicalSex("filly")).toBe("F");
    expect(canonicalSex("R")).toBe("R");
    expect(canonicalSex("Horse")).toBe("H");
  });

  it("Fasig-Tipton no cambia (ya es la referencia)", () => {
    const fasig = hip({ horseName: "2025-RAVER", sex: "C", sire: "JACKIE'S WARRIOR", dam: "RAVER", consignor: "GRACIE BLOODSTOCK, AGENT", color: "B", foalYear: 2025 });
    expect(canonicalizeNormalizedHip(fasig)).toMatchObject({ horseName: "2025-RAVER", sire: "JACKIE'S WARRIOR", dam: "RAVER", color: "Bay" });
  });
});

describe("ID interno del catálogo de Keeneland desde su página pública", () => {
  // Estructura real (2026-10-26): JSON escapado dentro de un <script>, con
  // el sale_id del archivo en el MISMO objeto que la ruta pública.
  const block = (saleId: string, path: string) =>
    `{\\"type\\":\\"sale\\",\\"pdf_link_id\\":\\"10313\\",\\"sale_id\\":\\"${saleId}\\",\\"background_image\\":{\\"url\\":\\"x\\"},\\"resources\\":[{\\"nid\\":\\"1\\",\\"sale_id\\":\\"999\\"}],\\"path\\":\\"${path}\\"}`;
  const html = `<script>self.__next_f.push([1,"[${[
    block("132", "/2026/12/september-yearling-sale"),
    block("134", "/2026/13/championship-sale"),
    block("133", "/2026/14/november-breeding-stock-sale"),
    block("135", "/2026/15/november-horses-of-racing-age-sale"),
  ].join(",")}]"])</script>`;

  it("lee el sale_id del mismo bloque que la ruta (no del vecino ni de uno anidado)", () => {
    const ids = parseKeenelandCatalogIds(html);
    expect(ids.get("12")).toBe("132");
    expect(ids.get("13")).toBe("134");
    expect(ids.get("14")).toBe("133");
    expect(ids.get("15")).toBe("135");
  });

  it("página sin datos -> vacío (no inventa IDs)", () => {
    expect(parseKeenelandCatalogIds("<html></html>").size).toBe(0);
  });
});
