import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "boulder-qr-"));

const { route } = await import("../src/handlers.ts");
const { seedDoc, saveRoutesDoc } = await import("../src/routeStore.ts");

beforeEach(async () => {
  await saveRoutesDoc(seedDoc());
});

const KNOWN = "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814?hl=en";

describe("gyms + qr resolve api", () => {
  it("lists gyms with counts", async () => {
    const res = await route({ method: "GET", path: "/api/gyms", query: {}, headers: {} });
    assert.equal(res.status, 200);
    const gyms = (res.body as { gyms: { id: string }[] }).gyms;
    assert.ok(gyms.some((g) => g.id === "gym_berta"));
    assert.ok(gyms.some((g) => g.id === "gym_manual"));
  });

  it("known QR resolves without external fetch, no duplicate on rescan", async () => {
    const first = await route({
      method: "POST", path: "/api/qr/resolve", query: {}, headers: {},
      body: { payload: KNOWN, selectedGymId: "gym_berta" },
    });
    assert.equal(first.status, 200);
    assert.equal((first.body as { matched: boolean }).matched, true);
    const second = await route({
      method: "POST", path: "/api/qr/resolve", query: {}, headers: {},
      body: { payload: KNOWN, selectedGymId: "gym_berta" },
    });
    assert.equal((second.body as { route: { id: string } }).route.id,
      (first.body as { route: { id: string } }).route.id);
  });

  it("unknown valid beta7 URL creates minimal record with manual hint", async () => {
    const res = await route({
      method: "POST", path: "/api/qr/resolve", query: {}, headers: {},
      body: { payload: "https://beta7.app/route/AbCdEfGh12345678", selectedGymId: "gym_berta" },
    });
    assert.equal(res.status, 200);
    const body = res.body as { matched: boolean; warnings: string[]; manualFallback: { allowed: boolean } };
    assert.equal(body.matched, true);
    assert.equal(body.manualFallback.allowed, true);
    assert.ok(body.warnings.length > 0);
  });

  it("wrong gym warns instead of blocking", async () => {
    const res = await route({
      method: "POST", path: "/api/qr/resolve", query: {}, headers: {},
      body: { payload: KNOWN, selectedGymId: "gym_manual" },
    });
    assert.equal(res.status, 200);
    assert.ok((res.body as { warnings: string[] }).warnings.length > 0);
  });

  it("evil host -> 400 no fetch, non-route path -> 422 manual allowed", async () => {
    const evil = await route({
      method: "POST", path: "/api/qr/resolve", query: {}, headers: {},
      body: { payload: "https://beta7.app.evil.example/route/abcdefgh1234" },
    });
    assert.equal(evil.status, 400);
    const other = await route({
      method: "POST", path: "/api/qr/resolve", query: {}, headers: {},
      body: { payload: "https://beta7.app/user/someone" },
    });
    assert.equal(other.status, 422);
    assert.equal((other.body as { manualFallback: { allowed: boolean } }).manualFallback.allowed, true);
  });

  it("manual route create + enrich + filtered list", async () => {
    const created = await route({
      method: "POST", path: "/api/gym/routes", query: {}, headers: {},
      body: { gymId: "gym_manual", sector: "Угол", name: "Своя", gradeRaw: "6A", styles: ["footwork"] },
    });
    assert.equal(created.status, 201);
    const id = (created.body as { route: { id: string } }).route.id;
    const enriched = await route({
      method: "PUT", path: "/api/gym/route", query: {}, headers: {},
      body: { id, patch: { gradeRaw: "6B" } },
    });
    assert.equal(enriched.status, 200);
    assert.equal((enriched.body as { route: { grade: { raw: string } } }).route.grade.raw, "6B");
    const list = await route({
      method: "GET", path: "/api/gym/routes", query: { gymId: "gym_manual", styles: "footwork" }, headers: {},
    });
    assert.equal(list.status, 200);
    assert.ok((list.body as { items: unknown[] }).items.length >= 1);
  });

  it("unknown gym -> 404", async () => {
    const res = await route({
      method: "GET", path: "/api/gym/routes", query: { gymId: "nope" }, headers: {},
    });
    assert.equal(res.status, 404);
  });
});
