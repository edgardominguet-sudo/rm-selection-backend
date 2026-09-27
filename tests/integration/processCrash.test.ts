// Error real en un proceso Node (2026-09-26) — el caso exacto de
// producción. Jest no deja morir su propio proceso ante una promesa
// rechazada, por eso esto corre el servidor en un proceso Node aparte
// (harness/crashHarness.ts) y verifica si sigue vivo.
import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";

jest.setTimeout(60000);

const harness = path.join(__dirname, "harness", "crashHarness.ts");

function startHarness(env: Record<string, string> = {}): Promise<{ proc: ChildProcess; port: number; output: () => string; exited: Promise<number | null> }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["-r", "ts-node/register", harness], {
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = out.match(/HARNESS_PORT=(\d+)/);
      if (m) resolve({ proc, port: Number(m[1]), output: () => out, exited });
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("exit", () => reject(new Error(`el arnés terminó antes de arrancar:\n${out}`)));
  });
}

async function get(port: number, p: string) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(3000) });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

test("SIN la corrección: un error en una ruta async TUMBA el proceso (reproduce el problema original)", async () => {
  const h = await startHarness({ HARNESS_WITHOUT_FIX: "1" });
  await get(h.port, "/boom");
  const code = await Promise.race([h.exited, new Promise((r) => setTimeout(() => r("sigue-vivo"), 5000))]);
  expect(code).toBe(1);
  expect((await get(h.port, "/health")).status).toBe(0); // ya no responde nadie
});

test("CON la corrección: el error responde 500 controlado y el proceso sigue respondiendo normal", async () => {
  const h = await startHarness();
  try {
    const boom = await get(h.port, "/boom");
    expect(boom.status).toBe(500);
    expect(boom.body).toMatchObject({ code: "INTERNAL_ERROR" });

    const health = await get(h.port, "/health");
    expect(health.status).toBe(200);

    // Promesa rechazada suelta: queda registrada y el proceso sigue vivo.
    expect((await get(h.port, "/stray-rejection")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    expect((await get(h.port, "/health")).status).toBe(200);
    expect(h.output()).toContain("UNHANDLED-REJECTION");
    expect(h.output()).toContain("[api-error] GET /boom");
    expect(h.proc.exitCode).toBeNull();
  } finally {
    h.proc.kill();
  }
});
