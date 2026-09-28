// Guardado del catálogo (2026-09-28): estado de nacimiento y consignor real
// en upsertNormalizedHips, y Grand Sire por padrillo desde el PDF de
// pedigree (con un lector de PDF simulado — sin red).
import { randomUUID } from "node:crypto";
import { db } from "../../src/db";
import { upsertNormalizedHips } from "../../src/rankingService";
import { enrichGrandSiresFromPedigreePdfs } from "../../src/grandSireEnrichment";
import { cleanupTestData } from "./fixtures";
import { NormalizedHip } from "../../src/types";

jest.setTimeout(60000);
const tag = randomUUID().slice(0, 8);
let saleId: string;
const SIRE_A = `Pappacap ${tag}`;
const SIRE_B = `Lexitonian ${tag}`;
const SIRE_C = `Known Sire ${tag}`;

function pdfText(sireSire: string, sire: string, damSire: string) {
  return [
    "Consigned by X, Agent V",
    "Bay Colt",
    `${sireSire} ..........................`,
    "Some Mare..............................",
    `${damSire} ................`,
    "Other Mare ....................",
    `${sire} ..............................`,
    "Dam Name ............................",
    "(2019)",
  ].join("\n");
}

const hip = (n: string, over: Partial<NormalizedHip>): NormalizedHip => ({ hipNumber: n, media: [], ...over });

beforeAll(async () => {
  const sale = await db.sale.create({
    data: { house: "OBS", name: `Catalog Names ${tag}`, externalSaleId: `cn-${tag}`, startDate: new Date(Date.now() + 864e6), endDate: new Date(Date.now() + 864e6), catalogAccess: "FULL" },
  });
  saleId = sale.id;
  await db.$executeRawUnsafe(`INSERT INTO "Stallion" (id, name, "sireName", "sireNameSource", "updatedAt") VALUES ($1, $2, 'Previo', 'manual', now())`, `st-c-${tag}`, SIRE_C.toUpperCase());
});

afterAll(async () => {
  await db.$executeRawUnsafe(`DELETE FROM "Stallion" WHERE name = ANY($1::text[])`, [SIRE_A, SIRE_B, SIRE_C].map((s) => s.toUpperCase()));
  await cleanupTestData({ saleId });
});

test("upsert guarda estado y consignor real (de la fuente o derivado), sin tocar el texto original", async () => {
  await upsertNormalizedHips(
    saleId,
    [
      hip("1", { sire: SIRE_A, consignor: "Vinery Sales, Agent XVI", consignorBase: "Vinery Sales", bredState: "KY" }),
      hip("2", { sire: SIRE_B, consignor: "Glen Hill Farm Agent V" }),
    ],
    new Map()
  );
  const rows = await db.$queryRawUnsafe<Array<{ hipNumber: string; consignor: string; consignorBase: string | null; bredState: string | null }>>(
    `SELECT "hipNumber", consignor, "consignorBase", "bredState" FROM "Hip" WHERE "saleId" = $1 ORDER BY "hipNumber"`,
    saleId
  );
  expect(rows).toEqual([
    { hipNumber: "1", consignor: "Vinery Sales, Agent XVI", consignorBase: "Vinery Sales", bredState: "KY" },
    { hipNumber: "2", consignor: "Glen Hill Farm Agent V", consignorBase: "Glen Hill Farm", bredState: null },
  ]);
});

test("Grand Sire: un PDF por padrillo, verificado contra el catálogo; nunca pisa un dato existente", async () => {
  const fetched: string[] = [];
  const texts: Record<string, string> = {
    "https://pdf/1": pdfText("Gun Runner", SIRE_A, "Pioneerof the Nile"),
    "https://pdf/2": pdfText("Speightstown", "Otro Sire", "Imperialism"), // no coincide con el catálogo
    "https://pdf/3": pdfText("Nuevo", SIRE_C, "Tapit"),
  };
  const summary = await enrichGrandSiresFromPedigreePdfs(
    `Catalog Names ${tag}`,
    [
      hip("1", { sire: SIRE_A, damSire: "Pioneerof the Nile", pedigreePdfUrl: "https://pdf/1" }),
      hip("5", { sire: SIRE_A, damSire: "Pioneerof the Nile", pedigreePdfUrl: "https://pdf/1" }),
      hip("2", { sire: SIRE_B, damSire: "Imperialism", pedigreePdfUrl: "https://pdf/2" }),
      hip("3", { sire: SIRE_C, damSire: "Tapit", pedigreePdfUrl: "https://pdf/3" }),
    ],
    async (url) => {
      fetched.push(url);
      return texts[url] ?? null;
    }
  );
  expect(summary).toEqual({ sires: 3, alreadyKnown: 1, checked: 2, saved: 1, unverified: 1 });
  expect(fetched).toEqual(["https://pdf/1", "https://pdf/2"]); // SIRE_C ya tenía dato: no se lee
  const rows = await db.$queryRawUnsafe<Array<{ name: string; sireName: string | null; sireNameSource: string | null }>>(
    `SELECT name, "sireName", "sireNameSource" FROM "Stallion" WHERE name = ANY($1::text[]) ORDER BY name`,
    [SIRE_A, SIRE_B, SIRE_C].map((s) => s.toUpperCase())
  );
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  expect(byName[SIRE_A.toUpperCase()]).toMatchObject({ sireName: "Gun Runner", sireNameSource: `Pedigree PDF · Catalog Names ${tag} · HIP 1` });
  expect(byName[SIRE_B.toUpperCase()]).toBeUndefined(); // no verificado -> no se guarda nada
  expect(byName[SIRE_C.toUpperCase()]).toMatchObject({ sireName: "Previo", sireNameSource: "manual" });

  // Segunda corrida: todo lo verificable ya está -> no se vuelve a leer ningún PDF de SIRE_A.
  fetched.length = 0;
  await enrichGrandSiresFromPedigreePdfs(`Catalog Names ${tag}`, [hip("1", { sire: SIRE_A, damSire: "Pioneerof the Nile", pedigreePdfUrl: "https://pdf/1" })], async (url) => {
    fetched.push(url);
    return texts[url] ?? null;
  });
  expect(fetched).toEqual([]);
});
