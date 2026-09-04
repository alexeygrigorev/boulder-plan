import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertSafeBeta7Url, safeFetchBeta7Page, BETA7_FETCH_MAX_BYTES } from "../src/beta7fetch.ts";
import { UnsafeExternalUrlError } from "../src/beta7.ts";

function stubFetch(html: string, opts: { url?: string; status?: number; ctype?: string } = {}): typeof fetch {
  return (async () => new Response(html, {
    status: opts.status ?? 200,
    headers: { "content-type": opts.ctype ?? "text/html; charset=utf-8" },
  })) as typeof fetch;
}

describe("beta7 safe fetch (public pages, no API)", () => {
  it("rejects non-https, evil hosts, creds, ports without network", async () => {
    for (const u of [
      "http://beta7.app/route/x",
      "https://beta7.app.evil.example/route/abcdefgh",
      "https://user@beta7.app/route/abcdefgh",
      "https://beta7.app:8443/route/abcdefgh",
    ]) {
      assert.throws(() => assertSafeBeta7Url(u), UnsafeExternalUrlError, u);
    }
  });

  it("fetches an allowed page via stub", async () => {
    const page = await safeFetchBeta7Page(
      "https://beta7.app/route/abcdefgh1234",
      stubFetch("<html><body>hi</body></html>"),
    );
    assert.ok(page.html.includes("hi"));
  });

  it("rejects non-html content", async () => {
    await assert.rejects(
      () => safeFetchBeta7Page("https://beta7.app/route/abcdefgh1234", stubFetch("{}", { ctype: "application/json" })),
      /content type/i,
    );
  });

  it("rejects http error status", async () => {
    await assert.rejects(
      () => safeFetchBeta7Page("https://beta7.app/route/abcdefgh1234", stubFetch("nope", { status: 404 })),
      /HTTP 404/,
    );
  });

  it("rejects oversized responses", async () => {
    await assert.rejects(
      () => safeFetchBeta7Page(
        "https://beta7.app/route/abcdefgh1234",
        stubFetch("x".repeat(BETA7_FETCH_MAX_BYTES + 1)),
      ),
      /size limit/i,
    );
  });

  it("rejects redirect escaping the allowlist", async () => {
    const evil = (async () => {
      const r = new Response("<html></html>", { headers: { "content-type": "text/html" } });
      Object.defineProperty(r, "url", { value: "https://evil.example/phish" });
      return r;
    }) as typeof fetch;
    await assert.rejects(
      () => safeFetchBeta7Page("https://beta7.app/route/abcdefgh1234", evil),
      UnsafeExternalUrlError,
    );
  });
});
