import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "boulder-test-"));

const { route } = await import("../src/handlers.ts");
const { issueSessionToken } = await import("../src/jwt.ts");

const AUTH_ENV = {
  AUTH_BASE_URL: "https://auth.example.test",
  AUTH_CLIENT_ID: "test-client",
  AUTH_CALLBACK_URL: "https://app.example.test/auth/callback",
  AUTH_LOGOUT_URL: "https://app.example.test/",
  AUTH_ISSUER: "https://cognito.example.test/pool",
  AUTH_JWKS_URL: "https://cognito.example.test/pool/.well-known/jwks.json",
  JWT_SECRET: "x".repeat(60),
};

const savedEnv = { ...process.env };

beforeEach(() => {
  for (const k of Object.keys(AUTH_ENV)) delete process.env[k];
  delete process.env.JWT_SECRET;
});
afterEach(() => {
  process.env = { ...savedEnv, DATA_DIR: process.env.DATA_DIR };
});

describe("api", () => {
  it("health", async () => {
    const res = await route({ method: "GET", path: "/api/health", query: {}, headers: {} });
    assert.equal(res.status, 200);
    assert.equal((res.body as { ok: boolean }).ok, true);
  });

  it("plan day roundtrip + progress", async () => {
    const plan = await route({ method: "GET", path: "/api/plan", query: { date: "2026-09-08" }, headers: {} });
    assert.equal(plan.status, 200);
    const day = plan.body as { blocks: unknown[] };
    assert.ok(day.blocks.length > 5);

    const put = await route({
      method: "PUT", path: "/api/progress", query: {}, headers: {},
      body: { date: "2026-09-08", checks: { b01: true }, note: "test" },
    });
    assert.equal(put.status, 200);

    const get = await route({ method: "GET", path: "/api/progress", query: { date: "2026-09-08" }, headers: {} });
    assert.equal(get.status, 200);
    assert.equal((get.body as { checks: Record<string, boolean> }).checks.b01, true);
  });

  it("progress keeps note + metrics with updatedAt, getMany batch", async () => {
    const put = await route({
      method: "PUT", path: "/api/progress", query: {}, headers: {},
      body: { date: "2026-09-10", checks: { b01: true }, note: "техника одной фразой", metrics: { shoulder: 3, energy: 4 } },
    });
    assert.equal(put.status, 200);
    assert.ok(typeof (put.body as { updatedAt: string }).updatedAt === "string");
    const get = await route({ method: "GET", path: "/api/progress", query: { date: "2026-09-10" }, headers: {} });
    assert.equal(get.status, 200);
    const entry = get.body as { note: string; metrics: { shoulder: number; energy: number }; updatedAt: string };
    assert.equal(entry.note, "техника одной фразой");
    assert.deepEqual(entry.metrics, { shoulder: 3, energy: 4 });

    const { createStore } = await import("../src/storage.ts");
    const many = await createStore().getMany(["2026-09-10", "2026-09-11"]);
    assert.equal(many.get("2026-09-10")?.note, "техника одной фразой");
    assert.equal(many.get("2026-09-11"), undefined);
  });

  it("404 unknown", async () => {
    const res = await route({ method: "GET", path: "/api/nope", query: {}, headers: {} });
    assert.equal(res.status, 404);
  });

  it("auth disabled locally: open api, config disabled", async () => {
    const cfg = await route({ method: "GET", path: "/api/auth/config", query: {}, headers: {} });
    assert.equal(cfg.status, 200);
    assert.equal((cfg.body as { enabled: boolean }).enabled, false);
    const days = await route({ method: "GET", path: "/api/days", query: {}, headers: {} });
    assert.equal(days.status, 200);
  });

  it("auth enabled: gate + bearer pass + me", async () => {
    Object.assign(process.env, AUTH_ENV);
    const anon = await route({ method: "GET", path: "/api/days", query: {}, headers: {} });
    assert.equal(anon.status, 401);
    const token = issueSessionToken("google_123", "alexey@datatalks.club", AUTH_ENV.JWT_SECRET);
    const authed = await route({
      method: "GET", path: "/api/days", query: {},
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(authed.status, 200);
    const me = await route({
      method: "GET", path: "/api/auth/me", query: {},
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(me.status, 200);
    assert.equal((me.body as { email: string }).email, "alexey@datatalks.club");
    const bad = await route({
      method: "GET", path: "/api/days", query: {},
      headers: { authorization: "Bearer broken" },
    });
    assert.equal(bad.status, 401);
  });

  it("week with days and resources", async () => {
    const res = await route({ method: "GET", path: "/api/week", query: { id: "week_01_2026-09-07" }, headers: {} });
    assert.equal(res.status, 200);
    const week = res.body as { days: unknown[]; resources: { id: string; url: string }[] };
    assert.equal(week.days.length, 7);
    assert.ok(week.resources.some((r) => r.id === "R01" && r.url.startsWith("https://")));
    const missing = await route({ method: "GET", path: "/api/week", query: { id: "nope" }, headers: {} });
    assert.equal(missing.status, 404);
  });

  it("resources and glossary", async () => {
    const res = await route({ method: "GET", path: "/api/resources", query: {}, headers: {} });
    assert.equal(res.status, 200);
    assert.equal((res.body as unknown[]).length, 25);
    const g = await route({ method: "GET", path: "/api/glossary", query: {}, headers: {} });
    assert.equal(g.status, 200);
    assert.ok((g.body as { term: string }[]).some((t) => t.term === "Beta"));
  });

  it("activity range with done counts", async () => {
    await route({
      method: "PUT", path: "/api/progress", query: {}, headers: {},
      body: { date: "2026-09-08", checks: { b01: true }, note: "" },
    });
    const res = await route({
      method: "GET", path: "/api/activity",
      query: { from: "2026-09-07", to: "2026-09-09" }, headers: {},
    });
    assert.equal(res.status, 200);
    const days = (res.body as { days: { date: string; kind: string; requiredTotal: number; done: number }[] }).days;
    assert.equal(days.length, 3);
    assert.ok(days.every((d) => d.requiredTotal > 0 && d.done >= 0));
    assert.equal(days.find((d) => d.date === "2026-09-08")?.kind, "workout");
    const sunday = await route({
      method: "GET", path: "/api/activity",
      query: { from: "2026-09-13", to: "2026-09-13" }, headers: {},
    });
    assert.equal(((sunday.body as { days: { kind: string }[] }).days[0]?.kind), "sunday");
    const bad = await route({ method: "GET", path: "/api/activity", query: { from: "oops", to: "2026-09-09" }, headers: {} });
    assert.equal(bad.status, 400);
  });
});
