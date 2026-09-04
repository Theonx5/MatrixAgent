import test from "node:test";
import assert from "node:assert/strict";
import { ensureUpdaterKey, normalizeTag, readAppVersion } from "./publish-local.mjs";

test("normalizeTag accepts only v-prefixed semver tags", () => {
  assert.equal(normalizeTag("v0.2.7"), "v0.2.7");
  assert.equal(normalizeTag("v1.0.0"), "v1.0.0");
  assert.throws(() => normalizeTag("0.2.7"), /tag must look like/);
  assert.throws(() => normalizeTag("v0.2"), /tag must look like/);
  assert.throws(() => normalizeTag(undefined), /tag must look like/);
});

test("readAppVersion reads the version the update feed validates against", () => {
  const version = readAppVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/u);
});

test("ensureUpdaterKey refuses an encrypted key without a password", () => {
  const previous = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const previousPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  delete process.env.TAURI_SIGNING_PRIVATE_KEY;
  delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  try {
    // The repository's real key is rsign-encrypted, so this must fail closed
    // instead of letting tauri build hang on a password prompt.
    assert.throws(() => ensureUpdaterKey(), /password-protected/);
  } finally {
    if (previous !== undefined) process.env.TAURI_SIGNING_PRIVATE_KEY = previous;
    else delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    if (previousPassword !== undefined) {
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = previousPassword;
    }
  }
});
