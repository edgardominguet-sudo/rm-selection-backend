// Advanced Search — reglas puras (2026-09-27): validación, campos
// derivados, filtros combinados, orden y paginación. Ver src/search/searchLogic.ts.
import {
  parseSearchRequest,
  normalizeColor,
  saleStatusOf,
  salePriceOf,
  aiScoreOf,
  aiClassOf,
  birthYearOf,
  hipKey,
  applyDerivedFilters,
  sortCandidates,
  paginate,
  SearchCandidate,
  SEARCH_DEFAULT_PAGE_SIZE,
} from "../../src/search/searchLogic";
import { HttpError } from "../../src/api/errorHandler";

function cand(over: Partial<SearchCandidate>): SearchCandidate {
  return {
    hipId: over.hipNumber ? `id-${over.hipNumber}` : "id",
    key: "KEENELAND::12::1",
    hipNumber: "1",
    saleId: "s1",
    sessionDate: new Date("2026-09-20T16:00:00Z"),
    color: "Bay",
    birthYear: 2025,
    saleStatus: "NO_RESULT",
    price: null,
    aiScore: null,
    aiClass: "NOT_ANALYZED",
    isFavorite: false,
    ...over,
  };
}

describe("parseSearchRequest — validación", () => {
  test("pedido vacío: HIP ascendente, página 1, 50 por página", () => {
    const r = parseSearchRequest({});
    expect(r.sort).toEqual({ field: "HIP", direction: "ASC" });
    expect(r.page).toBe(1);
    expect(r.pageSize).toBe(SEARCH_DEFAULT_PAGE_SIZE);
  });
  test("recorta textos y descarta vacíos", () => {
    const r = parseSearchRequest({ q: "  Tapit ", sire: "   " });
    expect(r.q).toBe("Tapit");
    expect(r.sire).toBeUndefined();
  });
  test.each([
    [{ houses: ["SOTHEBYS"] }],
    [{ aiScoreMin: 11 }],
    [{ aiScoreMin: 9, aiScoreMax: 8 }],
    [{ priceMin: -1 }],
    [{ sort: { field: "NAME" } }],
    [{ saleDateFrom: "27/09/2026" }],
    [{ pageSize: 1000 }],
    [{ colors: ["Purple"] }],
    [{ reviewed: "REVIEWED" }], // sin reviewedKeys
    [{ q: 123 }],
  ])("rechaza datos inválidos con 400: %j", (body) => {
    expect(() => parseSearchRequest(body)).toThrow(HttpError);
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
  test("año de nacimiento: fecha completa primero, año del catálogo como respaldo", () => {
    expect(birthYearOf(new Date("2025-03-02T00:00:00Z"), 2024)).toBe(2025);
    expect(birthYearOf(null, 2025)).toBe(2025);
    expect(birthYearOf(null, null)).toBeNull();
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

describe("filtros combinados (AND)", () => {
  const base = [
    cand({ hipNumber: "1", aiScore: 9.1, aiClass: "EXCELENTE", isFavorite: true, color: "Bay", key: "K::1::1" }),
    cand({ hipNumber: "2", aiScore: 7.5, aiClass: "BIEN", isFavorite: true, color: "Chestnut", key: "K::1::2" }),
    cand({ hipNumber: "3", aiScore: null, aiClass: "NOT_ANALYZED", isFavorite: false, key: "K::1::3", saleStatus: "RNA" }),
    cand({ hipNumber: "4", aiScore: 8.6, aiClass: "EXCELENTE", isFavorite: false, key: "K::1::4", saleStatus: "SOLD", price: 250000 }),
  ];
  const f = (body: object) => applyDerivedFilters(base, parseSearchRequest(body)).map((c) => c.hipNumber);

  test("AI Score ≥ 8.5 + Mis Favoritos -> solo los que cumplen las dos", () => {
    expect(f({ aiScoreMin: 8.5, favoritesOnly: true })).toEqual(["1"]);
  });
  test("un rango de score nunca incluye HIP sin analizar", () => {
    expect(f({ aiScoreMin: 0 })).toEqual(["1", "2", "4"]);
  });
  test("clase 'Not analyzed' se puede pedir explícitamente", () => {
    expect(f({ aiClasses: ["NOT_ANALYZED"] })).toEqual(["3"]);
  });
  test("RNA / vendido + rango de precio", () => {
    expect(f({ saleStatuses: ["RNA"] })).toEqual(["3"]);
    expect(f({ priceMin: 200000, priceMax: 300000 })).toEqual(["4"]);
  });
  test("color + rango de HIP", () => {
    expect(f({ colors: ["Bay"], hipFrom: 1, hipTo: 3 })).toEqual(["1", "3"]);
    expect(f({ colors: ["Chestnut"] })).toEqual(["2"]);
  });
  test("Revisado ✓ / No revisado con las claves de este dispositivo", () => {
    expect(f({ reviewed: "REVIEWED", reviewedKeys: ["K::1::2", "K::1::4"] })).toEqual(["2", "4"]);
    expect(f({ reviewed: "NOT_REVIEWED", reviewedKeys: ["K::1::2", "K::1::4"] })).toEqual(["1", "3"]);
  });
});

describe("orden y paginación", () => {
  const list = [
    cand({ hipNumber: "100", aiScore: 8, price: 50000 }),
    cand({ hipNumber: "9", aiScore: null, price: null }),
    cand({ hipNumber: "25", aiScore: 9.5, price: 400000 }),
    cand({ hipNumber: "1000", aiScore: 7, price: null }),
  ];
  const order = (field: "HIP" | "AI_SCORE" | "PRICE", direction: "ASC" | "DESC") => sortCandidates(list, { field, direction }).map((c) => c.hipNumber);

  test("HIP numérico (9 < 25 < 100 < 1000), ascendente y descendente", () => {
    expect(order("HIP", "ASC")).toEqual(["9", "25", "100", "1000"]);
    expect(order("HIP", "DESC")).toEqual(["1000", "100", "25", "9"]);
  });
  test("AI Score: los no analizados siempre al final", () => {
    expect(order("AI_SCORE", "DESC")).toEqual(["25", "100", "1000", "9"]);
    expect(order("AI_SCORE", "ASC")).toEqual(["1000", "100", "25", "9"]);
  });
  test("Precio: sin precio siempre al final", () => {
    expect(order("PRICE", "DESC")).toEqual(["25", "100", "9", "1000"]);
  });
  test("paginación", () => {
    expect(paginate([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4]);
    expect(paginate([1, 2, 3], 3, 2)).toEqual([]);
  });
});
