// Protege parseFoalingDate (saleHouses/dateParsing.ts) — usado para el
// campo "Foaled: ..." del PDF de Pedigree de cada Hip. Verificado contra
// datos reales de Keeneland y Fasig-Tipton en vivo (2026-09-07, ver
// comentario del archivo fuente) — estos tests fijan exactamente esos
// formatos reales para que un cambio futuro no rompa el PDF en silencio.
import { parseFoalingDate } from "../../src/saleHouses/dateParsing";

describe("parseFoalingDate: formato MM/DD/YYYY (Keeneland field_foaling_date, Fasig-Tipton year_of_birth)", () => {
  test("caso real de Keeneland: '02/15/2025'", () => {
    const d = parseFoalingDate("02/15/2025");
    expect(d).toBeDefined();
    expect(d!.getUTCFullYear()).toBe(2025);
    expect(d!.getUTCMonth()).toBe(1); // febrero = índice 1
    expect(d!.getUTCDate()).toBe(15);
  });
  test("caso real de Fasig-Tipton: '03/27/2025'", () => {
    const d = parseFoalingDate("03/27/2025");
    expect(d!.getUTCFullYear()).toBe(2025);
    expect(d!.getUTCMonth()).toBe(2); // marzo
    expect(d!.getUTCDate()).toBe(27);
  });
  test("se guarda a mediodía UTC (evita que un huso horario negativo corra la fecha un día para atrás al mostrarla)", () => {
    const d = parseFoalingDate("05/16/2025")!;
    expect(d.getUTCHours()).toBe(12);
  });
  test("acepta día/mes de un solo dígito", () => {
    const d = parseFoalingDate("5/6/2025")!;
    expect(d.getUTCMonth()).toBe(4);
    expect(d.getUTCDate()).toBe(6);
  });
});

describe("parseFoalingDate: formato ISO de respaldo (YYYY-MM-DD)", () => {
  test("fecha ISO simple", () => {
    const d = parseFoalingDate("2025-04-12")!;
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(3);
    expect(d.getUTCDate()).toBe(12);
  });
  test("fecha ISO con hora (solo se usa la parte de fecha)", () => {
    const d = parseFoalingDate("2025-04-12T00:00:00.000Z")!;
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCDate()).toBe(12);
  });
});

describe("parseFoalingDate: nunca lanza, devuelve undefined ante datos inválidos", () => {
  test.each([
    [undefined],
    [null],
    [""],
    ["   "],
    ["NY"], // el caso real documentado: Fasig-Tipton 'foaled' NO es fecha, es estado de nacimiento
    ["no es una fecha"],
    ["13/40/2025"], // mes y día imposibles
    ["04/31/2025"], // abril no tiene 31 días — Date normalizaría en silencio si no se validara
    ["02/30/2025"], // 30 de febrero no existe
    ["04/12/1800"], // año fuera de rango razonable
    ["04/12/2200"],
  ])("entrada inválida %p -> undefined, sin lanzar", (raw) => {
    expect(() => parseFoalingDate(raw as any)).not.toThrow();
    expect(parseFoalingDate(raw as any)).toBeUndefined();
  });
});
