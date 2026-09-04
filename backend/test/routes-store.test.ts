import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "boulder-routes-"));

const { loadRoutesDoc, saveRoutesDoc, recordAttempt, startTimer, stopTimer, setRouteStatus } = await import(
  "../src/routeStore.ts"
);
const { parseGrade } = await import("../src/gradeMaps.ts");

beforeEach(async () => {
  const { seedDoc, saveRoutesDoc: save } = await import("../src/routeStore.ts");
  await save(seedDoc());
});

describe("routes storage (file-backed, single-doc design)", () => {
  it("seed has berta gym + example route with mapped grade", async () => {
    const d = await loadRoutesDoc();
    assert.ok(d.gyms.some((g) => g.id === "gym_berta"));
    assert.ok(d.routes.some((r) => r.grade.raw === "6C/LILA" && r.grade.normalizedDifficulty === 6.4));
  });

  it("unknown grade keeps raw, normalized null", () => {
    const g = parseGrade("9Z/PINK", "berta_v1");
    assert.equal(g.normalizedDifficulty, null);
    assert.equal(g.technical, "9Z");
  });

  it("attempt is idempotent by clientAttemptId, updates state", async () => {
    let d = await loadRoutesDoc();
    const routeId = d.routes[0]?.id ?? "";
    const first = recordAttempt(d, {
      clientAttemptId: "a1",
      routeId,
      workoutDate: "2026-09-08",
      exerciseId: null,
      result: "FAILED",
      failureReason: "FOOT_SLIP",
      perceivedDifficulty: null,
      restBeforeSeconds: null,
      climbingSeconds: null,
      notes: null,
    }, "2026-09-08T10:00:00.000Z");
    assert.equal(first.created, true);
    const retry = recordAttempt(d, {
      clientAttemptId: "a1",
      routeId,
      workoutDate: "2026-09-08",
      exerciseId: null,
      result: "FAILED",
      failureReason: "FOOT_SLIP",
      perceivedDifficulty: null,
      restBeforeSeconds: null,
      climbingSeconds: null,
      notes: null,
    }, "2026-09-08T10:00:05.000Z");
    assert.equal(retry.created, false);
    assert.equal(retry.attempt.id, first.attempt.id);
    assert.equal(d.states[routeId]?.totalAttempts, 1);
    await saveRoutesDoc(d);
    const reloaded = await loadRoutesDoc();
    assert.equal(reloaded.attempts.length, 1);
  });

  it("timer accumulates across start/stop", async () => {
    let d = await loadRoutesDoc();
    const routeId = d.routes[0]?.id ?? "";
    startTimer(d, "2026-09-08", routeId, "2026-09-08T10:00:00.000Z");
    const stopped = stopTimer(d, "2026-09-08", routeId, "2026-09-08T10:05:00.000Z");
    assert.equal(stopped.status, "STOPPED");
    assert.equal(stopped.accumulatedSeconds, 300);
    assert.equal(d.states[routeId]?.totalTimeSeconds, 300);
  });

  it("sent attempt flips state, history kept", async () => {
    let d = await loadRoutesDoc();
    const routeId = d.routes[0]?.id ?? "";
    recordAttempt(d, {
      clientAttemptId: "s1",
      routeId,
      workoutDate: "2026-09-08",
      exerciseId: null,
      result: "SENT",
      failureReason: null,
      perceivedDifficulty: 6,
      restBeforeSeconds: 120,
      climbingSeconds: null,
      notes: null,
    }, "2026-09-08T11:00:00.000Z");
    assert.equal(d.states[routeId]?.sent, true);
    setRouteStatus(d, routeId, "PROJECTING", {}, "2026-09-08T12:00:00.000Z");
    assert.equal(d.states[routeId]?.sent, true);
    assert.equal(d.attempts.length, 1);
  });
});
