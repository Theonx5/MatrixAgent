import test from "node:test";
import assert from "node:assert/strict";
import { mergeRemotePlatforms, normalizeTag, readAppVersion } from "./publish-local.mjs";

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

test("mergeRemotePlatforms keeps macOS updates alive during Windows-only releases", () => {
  const live = {
    version: "0.2.6",
    platforms: {
      "windows-x86_64": { url: "https://x/v0.2.6/old.exe", signature: "sig" },
      "darwin-aarch64": { url: "https://x/v0.2.6/old.app.tar.gz", signature: "sigmac" },
    },
  };
  const local = {
    version: "0.2.7",
    platforms: {
      "windows-x86_64": { url: "https://x/v0.2.7/new.exe", signature: "newsig" },
    },
  };
  const merged = mergeRemotePlatforms(live, local);
  assert.equal(merged.version, "0.2.7");
  assert.equal(merged.platforms["windows-x86_64"].url, "https://x/v0.2.7/new.exe");
  // macOS clients keep receiving the last dual-platform build.
  assert.equal(merged.platforms["darwin-aarch64"].url, "https://x/v0.2.6/old.app.tar.gz");
});

test("mergeRemotePlatforms drops stale entries once the local release covers them", () => {
  const live = {
    version: "0.2.6",
    platforms: {
      "windows-x86_64": { url: "https://x/v0.2.6/old.exe", signature: "sig" },
      "darwin-aarch64": { url: "https://x/v0.2.6/old.app.tar.gz", signature: "sigmac" },
    },
  };
  const local = {
    version: "0.3.0",
    platforms: {
      "windows-x86_64": { url: "https://x/v0.3.0/new.exe", signature: "sig" },
      "darwin-aarch64": { url: "https://x/v0.3.0/new.app.tar.gz", signature: "sigmac" },
    },
  };
  const merged = mergeRemotePlatforms(live, local);
  assert.deepEqual(Object.keys(merged.platforms).sort(), ["darwin-aarch64", "windows-x86_64"]);
  assert.equal(merged.platforms["darwin-aarch64"].url, "https://x/v0.3.0/new.app.tar.gz");
});
