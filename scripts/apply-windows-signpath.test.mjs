import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySignedWindowsInstaller, findSignedInstaller } from "./apply-windows-signpath.mjs";

test("replaces the installer, resigns the updater, and rebinds hashes", () => {
  const root = mkdtempSync(join(tmpdir(), "signpath-apply-"));
  const nsisDir = join(root, "nsis");
  const acceptedDir = join(root, "accepted");
  const signedDir = join(root, "signed", "nested");
  mkdirSync(nsisDir, { recursive: true });
  mkdirSync(acceptedDir, { recursive: true });
  mkdirSync(signedDir, { recursive: true });
  const name = "PaperMatrix_0.2.4_x64-setup.exe";
  const source = join(nsisDir, name);
  const accepted = join(acceptedDir, name);
  writeFileSync(source, "unsigned");
  writeFileSync(accepted, "unsigned");
  writeFileSync(join(signedDir, name), "signpath-signed");
  const manifestPath = join(root, "PACKAGE_RELEASE.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      status: "ok",
      sourceInstaller: source,
      primaryInstaller: accepted,
      primaryInstallerSha256: "old",
      sourceInstallerSha256: "old",
    }),
  );

  const result = applySignedWindowsInstaller({
    packageManifestPath: manifestPath,
    signedDir: join(root, "signed"),
    signUpdater: (installerPath) => {
      writeFileSync(`${installerPath}.sig`, "minisign-after-authenticode");
    },
  });

  assert.equal(readFileSync(source, "utf8"), "signpath-signed");
  assert.equal(readFileSync(accepted, "utf8"), "signpath-signed");
  assert.equal(readFileSync(`${source}.sig`, "utf8"), "minisign-after-authenticode");
  assert.equal(result.authenticode.kind, "signpath");
  assert.equal(result.primaryInstallerSha256, result.sourceInstallerSha256);
  assert.match(result.primaryInstallerSha256, /^[a-f0-9]{64}$/);
  const saved = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(saved.primaryInstallerSha256, result.primaryInstallerSha256);
});

test("finds the signed installer in a nested SignPath output folder", () => {
  const root = mkdtempSync(join(tmpdir(), "signpath-find-"));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  const name = "PaperMatrix_0.2.4_x64-setup.exe";
  writeFileSync(join(nested, name), "signed");
  assert.equal(findSignedInstaller(root, name), join(nested, name));
});
