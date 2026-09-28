// Reglas de nombres del catálogo (2026-09-28): consignor real, estado de
// nacimiento y Grand Sire desde el PDF de pedigree de OBS. Los textos de PDF
// son extractos reales de la venta 155 (HIP 1, 2 y 12).
import { consignorBaseName, normalizeBredState, parseObsPedigreeCross, extractVerifiedGrandSire } from "../../src/catalogNames";

describe("consignorBaseName — el rol de agente no crea otro consignor", () => {
  test.each([
    ["Vinery Sales, Agent XVI", "Vinery Sales"],
    ["Vinery Sales, Agent", "Vinery Sales"],
    ["Colin Brennan Bloodstock at Highlander Training Center Agent V", "Colin Brennan Bloodstock at Highlander Training Center"],
    ["Kaizen Sales (Richard Kent), Agent V", "Kaizen Sales (Richard Kent)"],
    ["Warrendale Sales, Agent for Stonestreet Bred & Raised", "Warrendale Sales"],
    ["TAYLOR MADE SALES AGENCY, AGENT XIII", "TAYLOR MADE SALES AGENCY"],
    ["Hill 'n' Dale at Xalapa, Agent", "Hill 'n' Dale at Xalapa"],
    ["Glen Hill Farm", "Glen Hill Farm"],
    ["Paramount Sales Agency", "Paramount Sales Agency"],
    ["  McMahon of Saratoga Thoroughbreds LLC  ", "McMahon of Saratoga Thoroughbreds LLC"],
  ])("%s -> %s", (raw, expected) => {
    expect(consignorBaseName(raw)).toBe(expected);
  });

  test("vacío o solo el rol -> null (nunca se inventa)", () => {
    expect(consignorBaseName(null)).toBeNull();
    expect(consignorBaseName("   ")).toBeNull();
  });
});

describe("normalizeBredState", () => {
  test("códigos reales de la fuente", () => {
    expect(normalizeBredState("KY")).toBe("KY");
    expect(normalizeBredState(" fl ")).toBe("FL");
    expect(normalizeBredState("IRE")).toBe("IRE");
  });
  test("vacío o inválido -> null", () => {
    expect(normalizeBredState("")).toBeNull();
    expect(normalizeBredState(null)).toBeNull();
    expect(normalizeBredState("Kentucky")).toBeNull();
  });
});

const HIP1 = `Consigned by Colin Brennan Bloodstock
at Highlander Training Center, Agent V
Bay Colt
Candy Ride (ARG)
Quiet Giant
Scat Daddy
Redmeansgo
Empire Maker
Star of Goshen
Vindication
Lindsay Frolic
Gun Runner ..........................
Pappascat..............................
Pioneerof the Nile ................
Romantic Frolic ....................
Pappacap ..............................
Ice Maiden ............................
(2019)
Bay Colt
April 28, 2025
By PAPPACAP (2019). Black-type winner of 2 races, $842,430, Best Pal S. [G2]
Foaled in Kentucky.`;

const HIP2 = `Consigned by Skies Thoroughbreds, Agent I
Gray or Roan Filly
Gone West
Silken Cat
Tapit
Swap Fliparoo
Langfuhr
Bodhavista
General Meeting
Parlay
Speightstown ........................
Riviera Romper ....................
Imperialism ..........................
Meetmeontime......................
Lexitonian..............................
Im a Southern Diva ..............
(2011)`;

describe("Grand Sire desde el PDF de pedigree de OBS", () => {
  test("lee los seis nombres del cuadro en su orden", () => {
    expect(parseObsPedigreeCross(HIP1)).toEqual({
      sireSire: "Gun Runner",
      sireDam: "Pappascat",
      damSire: "Pioneerof the Nile",
      damDam: "Romantic Frolic",
      sire: "Pappacap",
      dam: "Ice Maiden",
    });
  });

  test("Grand Sire verificado contra el catálogo (Sire y Broodmare Sire)", () => {
    expect(extractVerifiedGrandSire(HIP1, { sire: "Pappacap", damSire: "Pioneerof the Nile" })).toBe("Gun Runner");
    expect(extractVerifiedGrandSire(HIP2, { sire: "LEXITONIAN", damSire: "imperialism" })).toBe("Speightstown");
  });

  test("si el PDF no coincide con el catálogo, no devuelve nada", () => {
    expect(extractVerifiedGrandSire(HIP1, { sire: "Gun Runner", damSire: "Pioneerof the Nile" })).toBeNull();
    expect(extractVerifiedGrandSire(HIP1, { sire: "Pappacap", damSire: "Tapit" })).toBeNull();
  });

  test("texto incompleto o de otro formato -> null", () => {
    expect(parseObsPedigreeCross("Consigned by X\nBay Colt")).toBeNull();
    expect(extractVerifiedGrandSire("", { sire: "Pappacap" })).toBeNull();
  });
});
