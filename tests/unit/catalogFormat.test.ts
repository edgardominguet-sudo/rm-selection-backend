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

import { parseHipGroupingText } from "../../src/saleHouses/keenelandHipGrouping";

describe("Hip Summary de Keeneland de una sola jornada (sin número de sesión)", () => {
  it("lee la jornada de la Horses of Racing Age 2026 (texto real del PDF)", () => {
    const text = "\n\nUpdated 10/20/26 \n \n2026 NOVEMBER HORSES OF RACING AGE SALE \nNovember 12 \nDate \nStart \nTime \nHip # \n# \nHead \nThursday, November 12 12:00 pm 4001 - 4128 128 \nTotal Head – 128 \n \nSale Begins with the letter E \n";
    const days = parseHipGroupingText(text);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ sessionNumber: 1, hipRangeStart: "4001", hipRangeEnd: "4128", headCount: 128, startTimeLabel: "12:00 pm" });
    expect(days[0].date.toISOString()).toBe("2026-11-12T16:00:00.000Z");
  });

  it("las ventas con número de sesión siguen igual", () => {
    const days = parseHipGroupingText("2026 SEPTEMBER YEARLING SALE\n1\n3 Wednesday, September 16 11:00 am 381 – 757 377\n");
    expect(days[0]).toMatchObject({ sessionNumber: 3, book: "1", hipRangeStart: "381", hipRangeEnd: "757", headCount: 377 });
  });
});

describe("Hip Summary de Keeneland con Book y Session en la misma línea", () => {
  it("lee la sesión 1 de la Breeding Stock 2026 y las siguientes con su Book", () => {
    const text = "2026 NOVEMBER BREEDING STOCK SALE\nNovember 3 - 11\nBook\nSession\nDate\n1 1 Tuesday, November 3 1:00 pm 1 - 268 268\n2\n2 Wednesday, November 4 10:00 am 301 – 719 419\n3 Thursday, November 5 10:00 am 720 – 1140 421\n";
    const days = parseHipGroupingText(text);
    expect(days.map((d) => [d.book, d.sessionNumber, d.hipRangeStart, d.hipRangeEnd])).toEqual([
      ["1", 1, "1", "268"],
      ["2", 2, "301", "719"],
      ["2", 3, "720", "1140"],
    ]);
  });
});
