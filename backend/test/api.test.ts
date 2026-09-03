import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "boulder-test-"));

const { route } = await import("../src/handlers.ts");

describe("api", () => {
  it("health", async () => {
    const res = await route({ method: "GET", path: "/api/health", query: {} });
    assert.equal(res.status, 200);
    assert.equal((res.body as { ok: boolean }).ok, true);
  });

  it("plan day roundtrip + progress", async () => {
    const plan = await route({ method: "GET", path: "/api/plan", query: { date: "2026-09-08" } });
    assert.equal(plan.status, 200);
    const day = plan.body as { blocks: unknown[] };
    assert.ok(day.blocks.length > 5);

    const put = await route({
      method: "PUT", path: "/api/progress", query: {},
      body: { date: "2026-09-08", checks: { b01: true }, note: "test" },
    });
    assert.equal(put.status, 200);

    const get = await route({ method: "GET", path: "/api/progress", query: { date: "2026-09-08" } });
    assert.equal(get.status, 200);
    assert.equal((get.body as { checks: Record<string, boolean> }).checks.b01, true);
  });

  it("404 unknown", async () => {
    const res = await route({ method: "GET", path: "/api/nope", query: {} });
    assert.equal(res.status, 404);
  });
});
