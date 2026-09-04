import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDistManifest,
  classifyUpdateAsset,
  maxPlatformVersion,
  mergePlatformEntry,
  readNotesFile,
  semverCompare,
} from "./assemble-dist.mjs";

test("semverCompare is numeric, not lexicographic", () => {
  assert.equal(semverCompare("0.3.1", "0.3.0"), 1);
  assert.equal(semverCompare("0.10.0", "0.9.0"), 1); // lexicographic would say -1
  assert.equal(semverCompare("1.0.0", "0.9.9"), 1);
  assert.equal(semverCompare("0.2.6", "0.2.6"), 0);
  assert.equal(semverCompare("0.2.6", "0.2.7"), -1);
});

test("maxPlatformVersion picks the numeric max across platform entries", () => {
  assert.equal(
    maxPlatformVersion({
      "windows-x86_64": { version: "0.3.1" },
      "darwin-aarch64": { version: "0.3.0" },
    }),
    "0.3.1",
  );
  assert.equal(
    maxPlatformVersion({
      "windows-x86_64": { version: "0.2.9" },
      "darwin-aarch64": { version: "0.3.0" },
    }),
    "0.3.0",
  );
  assert.equal(maxPlatformVersion({}), null);
});

test("classifyUpdateAsset maps staged artifacts by platform and role", () => {
  assert.deepEqual(classifyUpdateAsset("PaperMatrix_0.2.6_x64-setup.exe"), {
    platform: "windows-x86_64",
    kind: "installer",
  });
  assert.deepEqual(classifyUpdateAsset("PaperMatrix_0.3.0_aarch64.app.tar.gz"), {
    platform: "darwin-aarch64",
    kind: "updater",
  });
  assert.deepEqual(classifyUpdateAsset("PaperMatrix_0.3.0_aarch64.dmg"), {
    platform: "darwin-aarch64",
    kind: "installer",
  });
  assert.equal(classifyUpdateAsset("PaperMatrix_0.2.6_x64-setup.exe.sig"), null);
  assert.equal(classifyUpdateAsset("random.txt"), null);
});

test("mergePlatformEntry keeps the other platform's version/notes/URL verbatim", () => {
  const live = {
    version: "0.3.0",
    pub_date: "2026-09-01T00:00:00Z",
    notes: "mac feature",
    platforms: {
      "windows-x86_64": {
        signature: "oldwin",
        url: "https://x/files/v0.2.9/win.exe",
        version: "0.2.9",
        notes: "win fix",
      },
      "darwin-aarch64": {
        signature: "sigmac",
        url: "https://x/files/v0.3.0/mac.app.tar.gz",
        version: "0.3.0",
        notes: "mac feature",
      },
    },
  };
  const manifest = mergePlatformEntry(
    live,
    "windows-x86_64",
    {
      signature: "newwin",
      url: "https://x/files/v0.3.1/win.exe",
      version: "0.3.1",
      notes: "win fix2",
    },
    { notes: "win fix2", pubDate: "2026-09-04T02:08:20Z" },
  );
  // Top-level version is the max across platforms; notes/pub_date are this release's.
  assert.equal(manifest.version, "0.3.1");
  assert.equal(manifest.notes, "win fix2");
  assert.equal(manifest.pub_date, "2026-09-04T02:08:20Z");
  // The untouched macOS channel survives with its own version and URL.
  assert.equal(manifest.platforms["darwin-aarch64"].version, "0.3.0");
  assert.equal(manifest.platforms["darwin-aarch64"].url, "https://x/files/v0.3.0/mac.app.tar.gz");
  assert.equal(manifest.platforms["darwin-aarch64"].notes, "mac feature");
  assert.equal(manifest.platforms["windows-x86_64"].version, "0.3.1");
});

test("mergePlatformEntry without a seed treats the release as the whole feed", () => {
  const manifest = mergePlatformEntry(
    null,
    "darwin-aarch64",
    {
      signature: "sigmac",
      url: "https://x/files/v0.3.0/mac.app.tar.gz",
      version: "0.3.0",
      notes: "mac",
    },
    { notes: "mac", pubDate: "2026-09-04T00:00:00Z" },
  );
  assert.equal(manifest.version, "0.3.0");
  assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64"]);
});

test("buildDistManifest rejects a staged dir without this platform's updater", () => {
  const staged = {
    "PaperMatrix_0.3.0_aarch64.dmg": "dmg-bytes",
    "PaperMatrix_0.3.0_aarch64.app.tar.gz.sig": "sigmac",
  };
  assert.throws(
    () =>
      buildDistManifest({
        version: "0.3.0",
        platform: "darwin-aarch64",
        assetsDir: staged, // not a real dir — collectPlatformAssets fails closed
        baseUrl: "https://papermatrix.online",
        notes: "n",
        pubDate: "2026-09-04T00:00:00Z",
        live: null,
      }),
    /missing|no updater/,
  );
});

test("readNotesFile reads UTF-8 notes and trims trailing newlines", () => {
  const dir = mkdtempSync(join(tmpdir(), "pideck-notes-"));
  try {
    const path = join(dir, "notes.txt");
    writeFileSync(path, "发布管线改造：Windows 本地直发轨道上线\n", "utf8");
    assert.equal(readNotesFile(path), "发布管线改造：Windows 本地直发轨道上线");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readNotesFile rejects missing and empty notes files", () => {
  assert.throws(
    () => readNotesFile(join(tmpdir(), "definitely-missing-notes.txt")),
    /cannot read notes file/,
  );
  const dir = mkdtempSync(join(tmpdir(), "pideck-notes-"));
  try {
    const empty = join(dir, "empty.txt");
    writeFileSync(empty, "  \n", "utf8");
    assert.throws(() => readNotesFile(empty), /notes file is empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
