import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "boulder-state-"));

const { route } = await import("../src/handlers.ts");
const { seedDoc, saveRoutesDoc } = await import("../src/routeStore.ts");

beforeEach(async () => {
  await saveRoutesDoc(seedDoc());
});

async function seedRouteId(): Promise<string> {
  const res = await route({ method: "GET", path: "/api/gym/routes", query: { gymId: "gym_berta" }, headers: {} });
  return (res.body as { items: { route: { id: string } }[] }).items[0]?.route.id ?? "";
}

describe("route state + attempts + timers", () => {
  it("status update validates + persists", async () => {
    const id = await seedRouteId();
    const bad = await route({
      method: "PUT", path: "/api/route/state", query: {}, headers: {},
      body: { routeId: id, status: "NOPE" },
    });
    assert.equal(bad.status, 400);
    const ok = await route({
      method: "PUT", path: "/api/route/state", query: {}, headers: {},
      body: { routeId: id, status: "WANT_TO_TRY", priority: 3 },
    });
    assert.equal(ok.status, 200);
    assert.equal((ok.body as { status: string }).status, "WANT_TO_TRY");
  });

  it("attempt records once per idempotency key; second returns 200 same id", async () => {
    const id = await seedRouteId();
    const body = { routeId: id, clientAttemptId: "att-1", result: "FAILED", failureReason: "FOOT_SLIP", workoutDate: "2026-09-08" };
    const first = await route({ method: "POST", path: "/api/route/attempts", query: {}, headers: {}, body });
    assert.equal(first.status, 201);
    const second = await route({ method: "POST", path: "/api/route/attempts", query: {}, headers: {}, body });
    assert.equal(second.status, 200);
    assert.equal(
      (second.body as { id: string }).id,
      (first.body as { id: string }).id,
    );
  });

  it("sent flips state; flash after attempts needs override", async () => {
    const id = await seedRouteId();
    await route({
      method: "POST", path: "/api/route/attempts", query: {}, headers: {},
      body: { routeId: id, clientAttemptId: "fail-1", result: "FAILED", workoutDate: "2026-09-08" },
    });
    const flashDenied = await route({
      method: "POST", path: "/api/route/attempts", query: {}, headers: {},
      body: { routeId: id, clientAttemptId: "flash-2", result: "FLASHED", workoutDate: "2026-09-08" },
    });
    assert.equal(flashDenied.status, 400);
    const sent = await route({
      method: "POST", path: "/api/route/attempts", query: {}, headers: {},
      body: { routeId: id, clientAttemptId: "sent-3", result: "SENT", workoutDate: "2026-09-08" },
    });
    assert.equal(sent.status, 201);
    const card = await route({ method: "GET", path: "/api/route", query: { id }, headers: {} });
    assert.equal((card.body as { personalState: { sent: boolean } }).personalState.sent, true);
  });

  it("timer start/stop roundtrip", async () => {
    const id = await seedRouteId();
    const start = await route({
      method: "POST", path: "/api/route/timer/start", query: {}, headers: {},
      body: { routeId: id, workoutDate: "2026-09-08" },
    });
    assert.equal(start.status, 200);
    assert.equal((start.body as { status: string }).status, "RUNNING");
    const stop = await route({
      method: "POST", path: "/api/route/timer/stop", query: {}, headers: {},
      body: { routeId: id, workoutDate: "2026-09-08" },
    });
    assert.equal((stop.body as { status: string }).status, "STOPPED");
  });

  it("unknown route -> 404", async () => {
    const res = await route({
      method: "PUT", path: "/api/route/state", query: {}, headers: {},
      body: { routeId: "nope", status: "SENT" },
    });
    assert.equal(res.status, 404);
  });
});
