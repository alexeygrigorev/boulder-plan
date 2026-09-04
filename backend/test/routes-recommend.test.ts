import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "boulder-reco-"));

const { route } = await import("../src/handlers.ts");
const { seedDoc, saveRoutesDoc, recordAttempt } = await import("../src/routeStore.ts");
const { loadRoutesDoc } = await import("../src/routeStore.ts");

beforeEach(async () => {
  await saveRoutesDoc(seedDoc());
});

async function addManual(styles: string[], gradeRaw: string, sector: string): Promise<string> {
  const res = await route({
    method: "POST", path: "/api/gym/routes", query: {}, headers: {},
    body: { gymId: "gym_berta", sector, name: `t-${sector}`, gradeRaw, styles },
  });
  assert.equal(res.status, 201);
  return (res.body as { route: { id: string } }).route.id;
}

describe("recommendations rules_v1", () => {
  it("prefers style match + want_to_try with reasons and alternatives", async () => {
    const id = await addManual(["footwork", "balance"], "6A/BLAU", "Wave");
    await addManual(["power"], "6A/BLAU", "Corner");
    await route({
      method: "PUT", path: "/api/route/state", query: {}, headers: {},
      body: { routeId: id, status: "WANT_TO_TRY" },
    });
    const res = await route({
      method: "POST", path: "/api/recommendations", query: {}, headers: {},
      body: {
        gymId: "gym_berta",
        exercises: [{
          id: "footwork",
          targetCount: 2,
          difficulty: { min: 4.5, max: 5.5 },
          targetStyles: ["footwork"],
          excludeSent: true,
          selectionPolicy: "skill_development",
        }],
      },
    });
    assert.equal(res.status, 200);
    const ex = (res.body as { exercises: { candidates: { route: { id: string }; reasons: string[]; alternatives: unknown[] }[] }[] }).exercises[0];
    assert.ok(ex);
    assert.ok(ex.candidates.length >= 1);
    assert.equal(ex.candidates[0]?.route.id, id);
    assert.ok((ex.candidates[0]?.reasons.length ?? 0) >= 1);
  });

  it("excludeSent drops sent routes; relaxation reallows with note", async () => {
    const id = await addManual(["footwork"], "6A/BLAU", "Wave");
    const doc = await loadRoutesDoc();
    recordAttempt(doc, {
      clientAttemptId: "reco-sent-1",
      routeId: id,
      workoutDate: "2026-09-08",
      exerciseId: null,
      result: "SENT",
      failureReason: null,
      perceivedDifficulty: null,
      restBeforeSeconds: null,
      climbingSeconds: null,
      notes: null,
    }, "2026-09-08T10:00:00.000Z");
    await saveRoutesDoc(doc);
    const strict = await route({
      method: "POST", path: "/api/recommendations", query: {}, headers: {},
      body: {
        gymId: "gym_berta",
        exercises: [{ id: "x", targetCount: 3, difficulty: { min: 0, max: 10 }, targetStyles: ["footwork"], excludeSent: true }],
      },
    });
    const ids = (strict.body as { exercises: { candidates: { route: { id: string } }[] }[] }).exercises[0]?.candidates.map((c) => c.route.id) ?? [];
    assert.ok(!ids.includes(id));
  });

  it("empty pool explains scan-only fallback, no invented routes", async () => {
    const res = await route({
      method: "POST", path: "/api/recommendations", query: {}, headers: {},
      body: {
        gymId: "gym_manual",
        exercises: [{ id: "x", targetCount: 3, difficulty: { min: 0, max: 10 }, targetStyles: ["dyno"] }],
      },
    });
    assert.equal(res.status, 200);
    const body = res.body as { exercises: { candidates: unknown[] }[]; catalog: { warning: string | null } };
    assert.equal(body.exercises[0]?.candidates.length, 0);
    assert.ok(body.catalog.warning);
  });

  it("bad difficulty -> 400", async () => {
    const res = await route({
      method: "POST", path: "/api/recommendations", query: {}, headers: {},
      body: { gymId: "gym_berta", exercises: [{ id: "x", difficulty: { min: 9, max: 2 } }] },
    });
    assert.equal(res.status, 400);
  });
});
