import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isBeta7RoutePayload,
  normalizeBeta7RouteUrl,
  UnsupportedQrPayloadError,
  UnsafeExternalUrlError,
} from "../src/beta7.ts";

describe("beta7 qr normalization (adapted from integration package)", () => {
  it("valid route url canonicalizes, hl query dropped", () => {
    const r = normalizeBeta7RouteUrl(
      "https://beta7.app/route/jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814?hl=de#x",
    );
    assert.equal(r.externalId, "jzquGG3GoYgvvQzFrKXnzvecLwm2~1787667606814");
    assert.ok(!r.canonicalUrl.includes("hl="));
    assert.ok(isBeta7RoutePayload(r.canonicalUrl));
  });

  it("lookalike host rejected as unsafe", () => {
    assert.throws(
      () => normalizeBeta7RouteUrl("https://beta7.app.evil.example/route/abcdefgh"),
      UnsafeExternalUrlError,
    );
  });

  it("non-route path unsupported (no fetch)", () => {
    assert.throws(
      () => normalizeBeta7RouteUrl("https://beta7.app/user/someone"),
      UnsupportedQrPayloadError,
    );
  });

  it("credentials and ports rejected", () => {
    assert.throws(
      () => normalizeBeta7RouteUrl("https://user:pass@beta7.app/route/abcdefgh1234"),
      UnsafeExternalUrlError,
    );
    assert.throws(
      () => normalizeBeta7RouteUrl("https://beta7.app:8443/route/abcdefgh1234"),
      UnsafeExternalUrlError,
    );
  });

  it("non-http scheme rejected", () => {
    assert.throws(
      () => normalizeBeta7RouteUrl("javascript:alert(1)"),
      UnsafeExternalUrlError,
    );
  });

  it("empty and oversized payloads unsupported", () => {
    assert.throws(() => normalizeBeta7RouteUrl("   "), UnsupportedQrPayloadError);
    assert.throws(() => normalizeBeta7RouteUrl("x".repeat(3000)), UnsupportedQrPayloadError);
  });
});
