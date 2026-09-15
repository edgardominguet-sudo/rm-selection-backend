// Protege mediaFingerprint.ts: la huella que decide si "apareció media
// nueva" para un Hip. Una regresión acá tiene 2 formas de doler mucho:
// (1) falso positivo constante -> cada barrido reanaliza Hips sin
// cambios reales -> gasto de créditos Anthropic tirado a la basura
// (justo el tipo de incidente que motivó el trabajo del 2026-09-15); (2)
// falso negativo -> una foto nueva nunca dispara reanálisis, y el Hip se
// queda "congelado" con un resultado viejo para siempre.
import { normalizeMediaUrl, mediaFingerprint } from "../../src/analysis/mediaFingerprint";
import { CatalogMediaItem } from "../../src/types";

function media(kind: "photo" | "video", url: string): CatalogMediaItem {
  return { kind, url };
}

describe("normalizeMediaUrl", () => {
  test("quita query string y fragment", () => {
    expect(normalizeMediaUrl("https://cdn.example.com/hip82.jpg?token=abc123&exp=999#frag")).toBe(
      "https://cdn.example.com/hip82.jpg"
    );
  });
  test("dos URLs de la misma foto con distinto cache-busting normalizan igual", () => {
    const a = normalizeMediaUrl("https://cdn.example.com/hip82.jpg?v=1");
    const b = normalizeMediaUrl("https://cdn.example.com/hip82.jpg?v=2");
    expect(a).toBe(b);
  });
  test("URL no parseable se devuelve tal cual, sin lanzar", () => {
    expect(normalizeMediaUrl("no-es-una-url")).toBe("no-es-una-url");
  });
});

describe("mediaFingerprint", () => {
  test("la misma media (mismo set) produce siempre el mismo hash", () => {
    const set = [media("photo", "https://a.com/1.jpg"), media("video", "https://a.com/1.mp4")];
    expect(mediaFingerprint(set)).toBe(mediaFingerprint(set));
  });
  test("el orden de la media NO afecta el hash (evita falsos positivos si el catálogo reordena la respuesta)", () => {
    const a = [media("photo", "https://a.com/1.jpg"), media("photo", "https://a.com/2.jpg")];
    const b = [media("photo", "https://a.com/2.jpg"), media("photo", "https://a.com/1.jpg")];
    expect(mediaFingerprint(a)).toBe(mediaFingerprint(b));
  });
  test("cache-busting en la URL NO cambia el hash (evita reanálisis innecesario y su costo)", () => {
    const a = [media("photo", "https://a.com/1.jpg?token=xxx")];
    const b = [media("photo", "https://a.com/1.jpg?token=yyy")];
    expect(mediaFingerprint(a)).toBe(mediaFingerprint(b));
  });
  test("agregar una foto nueva SÍ cambia el hash", () => {
    const before = [media("photo", "https://a.com/1.jpg")];
    const after = [media("photo", "https://a.com/1.jpg"), media("photo", "https://a.com/2.jpg")];
    expect(mediaFingerprint(before)).not.toBe(mediaFingerprint(after));
  });
  test("cambiar photo por video en la misma URL SÍ cambia el hash", () => {
    const a = [media("photo", "https://a.com/1.jpg")];
    const b = [media("video", "https://a.com/1.jpg")];
    expect(mediaFingerprint(a)).not.toBe(mediaFingerprint(b));
  });
  test("lista vacía da un hash estable y determinístico (no lanza)", () => {
    expect(mediaFingerprint([])).toBe(mediaFingerprint([]));
    expect(typeof mediaFingerprint([])).toBe("string");
  });
  test("kinds distintos de photo/video (ej. 'document') se ignoran en el fingerprint", () => {
    const withDoc = [media("photo", "https://a.com/1.jpg"), { kind: "document", url: "https://a.com/x.pdf" } as unknown as CatalogMediaItem];
    const withoutDoc = [media("photo", "https://a.com/1.jpg")];
    expect(mediaFingerprint(withDoc)).toBe(mediaFingerprint(withoutDoc));
  });
});
