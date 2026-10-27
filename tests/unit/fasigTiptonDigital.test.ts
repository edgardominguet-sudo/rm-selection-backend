import { announcementsFromDigitalEvents, closingDay, normalizeDigitalListing, parseDigitalPage, parseListingDetail } from "../../src/saleHouses/fasigTiptonDigital";

jest.mock("../../src/db", () => ({ db: {} }));

describe("Fasig-Tipton Digital", () => {
  it("lee el bloque data-page (JSON escapado en HTML)", () => {
    const json = JSON.stringify({ component: "Events/Index", props: { events: [{ id: 67, title: "December Digital Sale 2026" }] } });
    const html = `<div id="app" data-page="${json.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`;
    expect(parseDigitalPage(html)?.props.events).toEqual([{ id: 67, title: "December Digital Sale 2026" }]);
    expect(parseDigitalPage("<html></html>")).toBeNull();
  });

  it("anuncia cada venta como Fasig-Tipton con id digital-{id} y su ventana de puja", () => {
    const [a] = announcementsFromDigitalEvents([
      { id: 67, title: "December Digital Sale 2026", slug: "december-digital-sale-2026", start_time: "2026-12-03T17:00:00.000000Z", end_time: "2026-12-08T19:00:00.000000Z" },
    ]);
    expect(a).toMatchObject({ externalSaleId: "digital-67", access: "FULL", isDigital: true, name: "December Digital Sale 2026" });
    expect(a.startDate.toISOString()).toBe("2026-12-03T17:00:00.000Z");
    expect(a.endDate?.toISOString()).toBe("2026-12-08T19:00:00.000Z");
  });

  it("el día de sesión es el día (hora del este) en que cierra la puja", () => {
    expect(closingDay("2026-10-13T16:00:00.000000Z")?.toISOString()).toBe("2026-10-13T16:00:00.000Z");
    expect(closingDay("2026-10-14T02:00:00.000000Z")?.toISOString()).toBe("2026-10-13T16:00:00.000Z"); // 10 p.m. ET del 13
  });

  const listing = {
    id: 8242, lot_number: "1", title: "A Thousand Miles", status: "passed", is_sold: false, sold_price: null,
    end_time: "2026-10-13T16:00:00.000000Z", sex: "F", color: "CH", sire: "Thousand Words", dam: "Swiss Army Wife",
    dob: "2022-05-06", foaled: "KY", seller_name: "Vann Belvoir, Agent for Bryon Seymore",
    hero: "https://x/hero.jpg", video: "https://vimeo.com/1232243479", url: "/sales/entry/8242/a-thousand-miles",
  };

  it("normaliza un lote con su ficha (abuelo materno, PDF y fotos)", () => {
    const detail = parseListingDetail({
      props: {
        listing: { meta: { sire_of_dam: "Colonel John" } },
        document_collection: { pedigree: [{ src: "https://vapor/75442/1.pdf" }] },
        media: [{ xl: "https://x/1-xl.jpg" }, { xl: "https://x/2-xl.jpg" }],
      },
    });
    const hip = normalizeDigitalListing(listing, detail, new Date("2026-10-20T00:00:00Z"));
    expect(hip).toMatchObject({
      hipNumber: "1", horseName: "A Thousand Miles", sire: "Thousand Words", dam: "Swiss Army Wife", damSire: "Colonel John",
      pedigreePdfUrl: "https://vapor/75442/1.pdf", bredState: "KY", foalYear: 2022, saleResult: { soldAsCode: "RNA" },
    });
    expect(hip.media).toEqual([
      { kind: "photo", url: "https://x/1-xl.jpg" },
      { kind: "photo", url: "https://x/2-xl.jpg" },
      { kind: "video", url: "https://vimeo.com/1232243479" },
    ]);
  });

  it("resultados: vendido con precio, retirado = OUT, sin vender solo después del cierre", () => {
    expect(normalizeDigitalListing({ ...listing, status: "sold", is_sold: true, sold_price: "150000.00" }, undefined, new Date()).saleResult).toEqual({ priceRaw: "150000", purchaser: undefined });
    expect(normalizeDigitalListing({ ...listing, status: "withdrawn" }, undefined, new Date()).saleResult).toEqual({ soldAsCode: "OUT" });
    expect(normalizeDigitalListing(listing, undefined, new Date("2026-10-12T00:00:00Z")).saleResult).toBeUndefined();
  });
});
