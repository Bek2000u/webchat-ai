import test from "node:test";
import assert from "node:assert/strict";
import { desktopPort, isAppUrl, isExternalUrl } from "../../src/desktop/security.js";
import { DEFAULT_SERVER_ORIGIN } from "../../src/extension/runtime/origin.js";

test("desktop and extension use the same local API port by default", () => {
  assert.equal(DEFAULT_SERVER_ORIGIN, "http://127.0.0.1:8001");
  assert.equal(new URL(DEFAULT_SERVER_ORIGIN).port, String(desktopPort(undefined)));
});

test("native shell rejects unsafe URLs and unrelated origins", () => {
  for (const value of ["file:///C:/secret", "javascript:alert(1)", "data:text/html,x", "https://user:password@example.com", "invalid"]) assert.equal(isExternalUrl(value), false);
  assert.equal(isExternalUrl("https://example.com/"), true);
  assert.equal(isAppUrl("http://127.0.0.1:8000/dashboard", "http://127.0.0.1:8000"), true);
  assert.equal(isAppUrl("http://127.0.0.1:8000.evil.test", "http://127.0.0.1:8000"), false);
  assert.equal(isAppUrl("http://127.0.0.1:9000", "http://127.0.0.1:8000"), false);
  assert.throws(() => desktopPort("invalid")); assert.throws(() => desktopPort("-1"));
  assert.equal(desktopPort(undefined), 8001); assert.equal(desktopPort("0"), 0);
});
