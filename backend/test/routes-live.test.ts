import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.env.DATA_DIR = process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "boulder-live-"));

const { route } = await import("../src/handlers.ts");
const { seedDoc, saveRoutesDoc, loadRoutesDoc } = await import("../src/routeStore.ts");
const { resolveQrLive } = await import("../src/routeApi.ts");
const { checkSyncRateLimit, syncGymCatalogFromHtml } = await import("../src/catalogSync.ts");

const here = dirname(fileURLToPath(import.meta.url));
const routeHtml = readFileSync(join(here, "fixtures", "beta7_route_wave.html"), "utf8");
const catalogHtml = readFileSync(join(here, "fixtures", "berta_catalog.html"), "utf8");

beforeEach(async () => {
  process.env.BETA7_OFF = "1";
  await saveRoutesDoc(seedDoc());
});

describe("live enrich + partial catalog sync (public pages)", () => {
  it("unknown QR enriches from the public route page", async () => {
    const doc = await loadRoutesDoc();
    const out = await resolveQrLive(
      doc,
      "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814?hl=en",
      "gym_berta",
      async () => ({ html: routeHtml }),
      "2026-09-04T10:00:00.000Z",
    );
    assert.equal(out.matched, true);
    assert.equal(out.route?.grade.raw, "6C/LILA");
    assert.equal(out.route?.setter, "fabi_pensel");
    assert.equal(out.route?.sector, "Wave");
    assert.ok(out.route?.styles.includes("footwork"));
  });

  it("fresh cached route needs no fetch", async () => {
    const doc = await loadRoutesDoc();
    let calls = 0;
    const out = await resolveQrLive(
      doc,
      "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814?hl=en",
      "gym_berta",
      async () => {
        calls += 1;
        return { html: routeHtml };
      },
      "2026-09-04T10:00:00.000Z",
    );
    // Seed-трасса от 2026-09-03: свежая (< 7 дней) и с деталями — fetch не нужен.
    // (Исключение: сид может протухнуть — тогда этот тест напомнит обновить сид.)
    assert.equal(calls, 0);
    assert.equal(out.route?.grade.raw, "6C/LILA");
  });

  it("fetch failure keeps the saved record with a warning", async () => {
    const doc = await loadRoutesDoc();
    const out = await resolveQrLive(
      doc,
      "https://beta7.app/route/AbCdEfGh12345678",
      "gym_berta",
      async () => {
        throw new Error("offline");
      },
    );
    assert.equal(out.matched, true);
    assert.ok(out.warnings.some((w) => w.includes("сохранён")));
  });

  it("catalog sync discovers without archiving the missing", async () => {
    const doc = await loadRoutesDoc();
    const archivedId = doc.routes[0]?.id ?? "";
    doc.routes[0].availability = "ARCHIVED";
    const run = syncGymCatalogFromHtml(doc, "gym_berta", catalogHtml, "2026-09-04T10:00:00.000Z");
    assert.equal(run.complete, false);
    assert.equal(run.totalSeen, 10);
    assert.equal(run.discovered, 10);
    // Частичный sync никого не архивирует и архивное не трогает.
    assert.equal(doc.routes.find((r) => r.id === archivedId)?.availability, "ARCHIVED");
    assert.equal(doc.catalogMeta.gym_berta?.status, "PARTIAL");
  });

  it("sync rate limit with force bypass", async () => {
    const doc = await loadRoutesDoc();
    syncGymCatalogFromHtml(doc, "gym_berta", catalogHtml, "2026-09-04T10:00:00.000Z");
    const limited = checkSyncRateLimit(doc, "gym_berta", Date.parse("2026-09-04T10:05:00.000Z"), false);
    assert.ok(limited);
    assert.equal(checkSyncRateLimit(doc, "gym_berta", Date.parse("2026-09-04T10:05:00.000Z"), true), null);
    assert.equal(checkSyncRateLimit(doc, "gym_berta", Date.parse("2026-09-04T11:00:00.000Z"), false), null);
  });

  it("handler sync endpoint disabled with BETA7_OFF", async () => {
    const res = await route({
      method: "POST", path: "/api/gym/sync", query: {}, headers: {},
      body: { gymId: "gym_berta" },
    });
    assert.equal(res.status, 503);
  });

  it("handler sync validates gym", async () => {
    const res = await route({
      method: "POST", path: "/api/gym/sync", query: {}, headers: {},
      body: { gymId: "nope" },
    });
    assert.equal(res.status, 404);
    const manual = await route({
      method: "POST", path: "/api/gym/sync", query: {}, headers: {},
      body: { gymId: "gym_manual" },
    });
    assert.equal(manual.status, 400);
  });
});
