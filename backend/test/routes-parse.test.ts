import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCatalogPage, parseRoutePage, styleFromEmoji } from "../src/beta7parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const routeHtml = readFileSync(join(here, "fixtures", "beta7_route_wave.html"), "utf8");
const catalogHtml = readFileSync(join(here, "fixtures", "berta_catalog.html"), "utf8");

describe("beta7 public-page parser (fixtures, no API)", () => {
  it("route page: all class A/B fields", () => {
    const p = parseRoutePage(
      routeHtml,
      "jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814",
      "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814",
    );
    assert.equal(p.data.name, "cornflower slopers & pinches");
    assert.equal(p.data.gradeRaw, "6C/LILA");
    assert.equal(p.data.setter, "fabi_pensel");
    assert.equal(p.data.gymHandle, "bertablock");
    assert.equal(p.data.sector, "Wave");
    for (const s of ["footwork", "complexity", "technic", "balance"]) {
      assert.ok(p.data.styles.includes(s), `style ${s}`);
    }
    assert.ok(p.data.styles.every((s) => !s.includes(".")), "no raw i18n keys in styles");
    assert.ok((p.data.sends ?? 0) > 0);
    assert.ok((p.fieldConfidence.gradeRaw ?? 0) >= 0.9);
  });

  it("untranslated i18n style keys map to the style dictionary", () => {
    const html = `<html><head><title>t 6A/BLAU • BETA7</title>
      <meta name="description" content="tension boulder with t 6A/BLAU from @s at @g (Sec) • 3 sends, 0 posts"></head>
      <body><h1><span class="style" title="route.styles.tension">x</span>
      <span class="style" title="route.styles.whatever">y</span></h1></body></html>`;
    const p = parseRoutePage(html, "x".repeat(16), "https://beta7.app/route/" + "x".repeat(16));
    assert.ok(p.data.styles.includes("tension"));
    assert.ok(!p.data.styles.some((s) => s.includes(".")));
    assert.ok(p.unknownTokens.some((t) => t.includes("whatever")));
  });

  it("route page without setter keeps card alive", () => {
    const cut = routeHtml.replace(/fabi_pensel/g, "").replace(/user name[^>]*>[^<]*</g, "user name> <");
    const p = parseRoutePage(cut, "x".repeat(16), "https://beta7.app/route/" + "x".repeat(16));
    assert.ok(p.data.gradeRaw.length > 0);
    assert.ok(p.warnings.length > 0);
  });

  it("catalog page: cards with grade/setter/sector", () => {
    const p = parseCatalogPage(catalogHtml);
    assert.equal(p.data.length, 10);
    const first = p.data[0];
    assert.ok(first);
    assert.ok(first.externalId.startsWith("6lbfqNyvRNhE8ROVnl9zvvThejO2"));
    assert.equal(first.gradeRaw, "6B+/LILA");
    assert.equal(first.setter, "Makita_Marv");
    assert.equal(first.sector, "Dicke Berta");
    assert.ok(first.styles.includes("footwork"));
  });

  it("unknown style emoji is reported, not silently dropped", () => {
    assert.equal(styleFromEmoji("💃"), "footwork");
    assert.equal(styleFromEmoji("🧘‍♂️"), "balance");
    assert.equal(styleFromEmoji("🧲"), null);
    const p = parseCatalogPage(catalogHtml);
    assert.ok(p.unknownTokens.includes("🧲"));
  });

  it("login/error page is not accepted as route", () => {
    const p = parseRoutePage("<html><head><title>Login</title></head><body>sign in</body></html>", "x".repeat(16), "https://beta7.app/route/" + "x".repeat(16));
    assert.ok(p.data.gradeRaw === "" && p.warnings.length > 0);
  });

  it("route page: og:image becomes sector photo, missing stays null", () => {
    const p = parseRoutePage(
      routeHtml,
      "jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814",
      "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814",
    );
    assert.ok(typeof p.data.photoUrl === "string" && p.data.photoUrl.startsWith("https://"));
    assert.ok((p.fieldConfidence.photoUrl ?? 0) > 0);
    const bare = parseRoutePage(
      "<html><head><title>t 6A/BLAU • BETA7</title></head><body><h1>x</h1></body></html>",
      "x".repeat(16),
      "https://beta7.app/route/" + "x".repeat(16),
    );
    assert.equal(bare.data.photoUrl, null);
  });
});
