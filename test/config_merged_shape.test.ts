import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

const TOKEN = env.PROXY_COORDINATOR_TOKEN;
const AUTH = { authorization: `Bearer ${TOKEN}` };

async function workerFetch(path: string, method: string, body?: unknown): Promise<Response> {
  const ctx = createExecutionContext();
  const req = new Request(`https://worker.test${path}`, {
    method,
    headers: { ...AUTH, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const resp = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return resp;
}

describe("ConfigState /do/config — Phase 3 merged shape", () => {
  it("returns a `merged` field with default-source entries when no overrides", async () => {
    const r = await workerFetch("/config", "GET", undefined);
    expect(r.status).toBe(200);
    const data: any = await r.json();
    expect(data.merged).toBeDefined();
    expect(typeof data.merged).toBe("object");
    // short_max has a default in wrangler.toml vars (SHORT_MAX="3")
    expect(data.merged.short_max).toBeDefined();
    expect(data.merged.short_max.source).toBe("default");
    expect(typeof data.merged.short_max.value).toBe("string");
  });

  it("flips source='override' after a PATCH", async () => {
    await workerFetch(
      "/config",
      "PATCH",
      { key: "short_max", value: "9", reason: "phase3 test" },
    );
    const r = await workerFetch("/config", "GET", undefined);
    const data: any = await r.json();
    expect(data.merged.short_max.value).toBe("9");
    expect(data.merged.short_max.source).toBe("override");
  });

  it("legacy `values` field is still present (backward compat)", async () => {
    const r = await workerFetch("/config", "GET", undefined);
    const data: any = await r.json();
    expect(data.values).toBeDefined();
  });
});
