jest.mock("../../src/db", () => ({ db: {} }));
import { obsAnnouncementFromApi, obsSaleDisplayName } from "../../src/saleHouses/discovery/obsDiscovery";
import { parseObsStartTimes } from "../../src/saleHouses/obs";

// Cabeceras reales de la API de OBS (2026-10-28).
const march = { sale_id: "149", sale_name: "2026 March 2YOs in Training Sale", sale_category: "2yo", sale_starts: "2026-03-10 04:00:00", sale_ends: "2026-03-12 04:00:00", is_digital: "0", next_sale_id: "150", previous_sale_id: "147" };
const spring = { sale_id: "150", sale_name: "2026 Spring 2YO in Training Sale", sale_category: "2yo", sale_starts: "2026-04-14 04:00:00", sale_ends: "2026-04-17 04:00:00", is_digital: "0" };
const june = { sale_id: "151", sale_name: "2026 June 2YO in Training and Horses of Racing Age Sale", sale_category: "2yo", sale_starts: "2026-06-16 04:00:00", sale_ends: "2026-06-18 04:00:00", is_digital: "0" };
const winter = { sale_id: "147", sale_name: "2026 Winter Mixed Live Sale", sale_category: "mixed", sale_starts: "2026-01-27 05:00:00", sale_ends: "2026-01-27 05:00:00", is_digital: "0" };

describe("OBS: ventas desde su propia API", () => {
  const now = new Date("2026-10-28T12:00:00Z");

  it("nombre corto por mes real de la venta", () => {
    expect(obsSaleDisplayName(march)).toBe("OBS Marzo 2YO");
    expect(obsSaleDisplayName(spring)).toBe("OBS Abril 2YO");
    expect(obsSaleDisplayName(june)).toBe("OBS Junio 2YO");
    expect(obsSaleDisplayName(winter)).toBe("OBS Enero Mixta");
    expect(obsSaleDisplayName({ sale_id: "155", sale_name: "2026 October Yearling Sale", sale_starts: "2026-10-06 04:00:00" })).toBe("OBS Octubre Yearlings");
  });

  it("venta terminada de este año: ID real, FULL y marcada para completar", () => {
    const a = obsAnnouncementFromApi(march, now)!;
    expect(a).toMatchObject({ externalSaleId: "149", access: "FULL", historicalBackfill: true });
    expect(a.startDate.toISOString()).toBe("2026-03-10T12:00:00.000Z");
    expect(a.endDate!.toISOString()).toBe("2026-03-12T12:00:00.000Z");
  });

  it("venta futura: sin marca histórica; año anterior: no se completa", () => {
    expect(obsAnnouncementFromApi({ ...march, sale_starts: "2027-03-09 04:00:00", sale_ends: "2027-03-11 04:00:00" }, now)!.historicalBackfill).toBeUndefined();
    expect(obsAnnouncementFromApi({ ...march, sale_starts: "2025-06-17 04:00:00", sale_ends: "2025-06-18 04:00:00" }, now)!.historicalBackfill).toBeUndefined();
  });

  it("digitales y ventas sin fecha se descartan", () => {
    expect(obsAnnouncementFromApi({ ...march, is_digital: "1" }, now)).toBeNull();
    expect(obsAnnouncementFromApi({ ...march, sale_starts: null }, now)).toBeNull();
  });
});

describe("OBS: hora de inicio en el formato de las ventas de 2 años", () => {
  it("'Sale Dates: March 10th - 12th, 2026 at 11:00 am' -> cada día del rango", () => {
    const map = parseObsStartTimes({
      sale_id: "149",
      sale_meta: [{ meta_key: "sale_info_header", meta_value: "<p>Updated 7/15/2026</p>\n<p>Sale Dates: March 10th - 12th, 2026 at 11:00 am (1 - 272, 273 - 544, 545 - 816)<br>Under Tack Dates: March 4th - 7th, 2026 at 8:00 am</p>" }],
    });
    expect([...map.entries()]).toEqual([
      ["2026-03-10", "11:00 am"],
      ["2026-03-11", "11:00 am"],
      ["2026-03-12", "11:00 am"],
    ]);
  });
  it("el formato de October sigue igual", () => {
    const map = parseObsStartTimes({ sale_id: "155", sale_meta: [{ meta_key: "sale_info_header", meta_value: "October 6th, 2026 starting at 12:00 pm (1 - 189)" }] });
    expect(map.get("2026-10-06")).toBe("12:00 pm");
  });
});
