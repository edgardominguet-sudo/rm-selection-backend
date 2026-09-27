// Search por venta — reglas puras (2026-09-27): validación del pedido
// (solo los filtros de la nueva ventana) y reglas de negocio reutilizadas de
// la versión anterior. Ver src/search/searchLogic.ts.
import {
  parseSaleSearchRequest,
  normalizeColor,
  saleStatusOf,
  salePriceOf,
  aiScoreOf,
  aiClassOf,
  hipKey,
  nameKey,
  compareHips,
  paginate,
  SEARCH_DEFAULT_PAGE_SIZE,
} from "../../src/search/searchLogic";
import { HttpError } from "../../src/api/errorHandler";

const base = { house: "OBS", externalSaleId: "obs-oct-2026" };

function expect400(body: unknown) {
  try {
    parseSaleSearchRequest(body);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    return;
  }
  throw new Error("se esperaba HttpError 400");
}

describe("parseSaleSearchRequest — validación", () => {
  test("solo venta: página 1, 50 por página, sin filtros", () => {
    const r = parseSaleSearchRequest(base);
    expect(r).toEqual({ ...base, page: 1, pageSize: SEARCH_DEFAULT_PAGE_SIZE, sires: undefined, dams: undefined, grandsires: undefined, broodmareSires: undefined, consignors: undefined, sexes: undefined, colors: undefined, dobFrom: undefined, dobTo: undefined });
  });

  test("la venta es obligatoria", () => {
    expect400({});
    expect400({ house: "OBS" });
    expect400({ externalSaleId: "x" });
  });

  test("listas: recorta, quita duplicados y descarta listas vacías", () => {
    const r = parseSaleSearchRequest({ ...base, sires: [" Into Mischief ", "Into Mischief", "Gun Runner"], dams: [] });
    expect(r.sires).toEqual(["Into Mischief", "Gun Runner"]);
    expect(r.dams).toBeUndefined();
  });

  test("sexo y color solo aceptan valores conocidos", () => {
    expect(parseSaleSearchRequest({ ...base, sexes: ["C", "F"], colors: ["Bay", "Gray/Roan"] })).toMatchObject({ sexes: ["C", "F"], colors: ["Bay", "Gray/Roan"] });
    expect400({ ...base, sexes: ["X"] });
    expect400({ ...base, colors: ["Palomino"] });
  });

  test("fecha de nacimiento: AAAA-MM-DD y rango ordenado", () => {
    expect(parseSaleSearchRequest({ ...base, dobFrom: "2025-01-15", dobTo: "2025-05-31" })).toMatchObject({ dobFrom: "2025-01-15", dobTo: "2025-05-31" });
    expect400({ ...base, dobFrom: "15/01/2025" });
    expect400({ ...base, dobFrom: "2025-06-01", dobTo: "2025-01-01" });
  });

  test("filtros viejos de la versión anterior ya no existen (se ignoran, no rompen)", () => {
    const r = parseSaleSearchRequest({ ...base, q: "Gun", aiScoreMin: 8, favoritesOnly: true });
    expect(r).not.toHaveProperty("q");
    expect(r).not.toHaveProperty("aiScoreMin");
  });

  test("tipos inválidos -> 400", () => {
    expect400({ ...base, sires: "Into Mischief" });
    expect400({ ...base, sires: [123] });
    expect400({ ...base, page: 0 });
    expect400({ ...base, pageSize: 1000 });
  });
});

describe("nombres y orden", () => {
  test("clave de nombre: mayúsculas y espacios normalizados (misma regla que el SQL)", () => {
    expect(nameKey("  Into   Mischief ")).toBe("INTO MISCHIEF");
    expect(nameKey("INTO MISCHIEF")).toBe(nameKey("Into Mischief"));
  });

  test("HIP en orden numérico (9 < 25 < 100 < 1000)", () => {
    expect(["1000", "25", "9", "100"].sort(compareHips)).toEqual(["9", "25", "100", "1000"]);
  });

  test("paginación", () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    expect(paginate(items, 1, 50)).toHaveLength(50);
    expect(paginate(items, 3, 50)).toEqual(items.slice(100));
    expect(paginate(items, 4, 50)).toEqual([]);
  });
});

describe("campos derivados", () => {
  test("clave de HIP idéntica a Hip.id de la app", () => {
    expect(hipKey("KEENELAND", "12", "4594")).toBe("KEENELAND::12::4594");
  });
  test.each([
    ["B", "Bay"], ["Bay", "Bay"], ["Dark Bay/Brown", "Dark Bay/Brown"], ["DB/BR", "Dark Bay/Brown"],
    ["Dark Bay or Brown", "Dark Bay/Brown"], ["Dark bay/br.", "Dark Bay/Brown"], ["CH", "Chestnut"],
    ["Gray/Roan", "Gray/Roan"], ["GR/RO", "Gray/Roan"], ["Gray or Roan", "Gray/Roan"], ["BLK", "Black"], ["Black", "Black"],
  ])("color %s -> %s (valores reales de la base)", (raw, expected) => {
    expect(normalizeColor(raw)).toBe(expected);
  });
  test("color desconocido o vacío -> null (nunca se inventa)", () => {
    expect(normalizeColor("Palomino")).toBeNull();
    expect(normalizeColor(null)).toBeNull();
  });
  test("resultado de venta: misma regla que SaleResult.outcome de la app", () => {
    expect(saleStatusOf({ priceRaw: "300000.00", purchaser: "Lael Stable" })).toBe("SOLD");
    expect(saleStatusOf({ purchaser: "R.N.A. (19,000)", soldAsCode: "RNA" })).toBe("RNA");
    // Retiro publicado por Fasig-Tipton como precio 0 + comprador "OUT": no es venta ni "$0".
    expect(saleStatusOf({ priceRaw: "0.00", purchaser: "OUT", soldAsCode: "Y" })).toBe("OUT");
    expect(salePriceOf({ priceRaw: "0.00", purchaser: "OUT", soldAsCode: "Y" })).toBeNull();
    expect(saleStatusOf({ priceRaw: "0.00", soldAsCode: "Y" })).toBe("NO_RESULT");
    expect(saleStatusOf({ soldAsCode: "OUT" })).toBe("OUT");
    expect(saleStatusOf({ soldAsCode: "PS", priceRaw: "5000" })).toBe("SOLD");
    expect(saleStatusOf({ soldAsCode: "W" })).toBe("NO_RESULT");
    expect(saleStatusOf(null)).toBe("NO_RESULT");
  });
  test("precio: solo de un HIP vendido; un RNA nunca tiene precio de venta", () => {
    expect(salePriceOf({ priceRaw: "17000.00", purchaser: "NRKH" })).toBe(17000);
    expect(salePriceOf({ purchaser: "R.N.A. (19,000)", soldAsCode: "RNA" })).toBeNull();
    expect(salePriceOf({ soldAsCode: "OUT" })).toBeNull();
  });
  test("HIP nunca analizado -> sin score y 'Not analyzed' (nunca se infiere)", () => {
    expect(aiScoreOf(null)).toBeNull();
    expect(aiClassOf(null)).toBe("NOT_ANALYZED");
    expect(aiScoreOf({ source: "MANUAL", overallScore: 9, conformationScoresJson: {}, landmarksJson: {} })).toBeNull();
  });
  test("clasificación IA: Excelente 8.5–10, Bien 7.0–8.4, Revisar ≤6.9", () => {
    expect(aiClassOf(10)).toBe("EXCELENTE");
    expect(aiClassOf(8.5)).toBe("EXCELENTE");
    expect(aiClassOf(8.4)).toBe("BIEN");
    expect(aiClassOf(7.0)).toBe("BIEN");
    expect(aiClassOf(6.9)).toBe("REVISAR");
  });
  test("score IA = misma regla única del Ranking del Día (lateral real)", () => {
    const score = aiScoreOf({
      source: "AI",
      overallScore: 7,
      conformationScoresJson: { "lateral.proportions": 9, "lateral.topline": 9, "lateral.structure": 9 },
      landmarksJson: { lateral: { available: true } },
    });
    expect(score).toBe(9);
  });
});

