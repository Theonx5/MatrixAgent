import test from "node:test";
import assert from "node:assert/strict";
import { ensureUpdaterKey, normalizeTag, parseArgs, readAppVersion } from "./publish-local.mjs";

test("normalizeTag accepts only v-prefixed semver tags", () => {
  assert.equal(normalizeTag("v0.2.7"), "v0.2.7");
  assert.equal(normalizeTag("v1.0.0"), "v1.0.0");
  assert.throws(() => normalizeTag("0.2.7"), /tag must look like/);
  assert.throws(() => normalizeTag("v0.2"), /tag must look like/);
  assert.throws(() => normalizeTag(undefined), /tag must look like/);
});

test("parseArgs accepts --notes-file for UTF-8 notes on the Windows release machine", () => {
  const args = parseArgs(["--tag", "v0.2.8", "--notes-file", "notes.txt"]);
  assert.equal(args.notesFile, "notes.txt");
  assert.equal(args.notes, "");
});

test("readAppVersion reads the version the update feed validates against", () => {
  const version = readAppVersion();
  assert.match(version, /^\d+\.\d+\.\d+$/u);
});

test("ensureUpdaterKey defaults the password to an explicit empty string", () => {
  const previous = process.env.TAURI_SIGNING_PRIVATE_KEY;
  const previousPassword = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  delete process.env.TAURI_SIGNING_PRIVATE_KEY;
  delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  try {
    // The release key is unencrypted; an UNSET password var makes tauri build
    // stall on an interactive prompt, so the loader pins an explicit "".
    ensureUpdaterKey();
    assert.equal(process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, "");
    assert.ok(process.env.TAURI_SIGNING_PRIVATE_KEY?.startsWith("dW50cnVzdGVk"));
  } finally {
    if (previous !== undefined) process.env.TAURI_SIGNING_PRIVATE_KEY = previous;
    else delete process.env.TAURI_SIGNING_PRIVATE_KEY;
    if (previousPassword !== undefined) {
      process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = previousPassword;
    } else {
      delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    }
  }
});
