/**
 * Replace the unsigned Windows installer with a SignPath-signed copy, then
 * re-create the Tauri updater minisign so hashes and .sig still match.
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { signUpdaterBundle } from "./release-signing.mjs";

function fail(message) {
  throw new Error(`[apply-windows-signpath] ${message}`);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(rootDir) {
  const found = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const path = join(rootDir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(path));
    else found.push(path);
  }
  return found;
}

export function findSignedInstaller(signedDir, expectedName) {
  if (!existsSync(signedDir)) fail(`signed directory missing: ${signedDir}`);
  const matches = walkFiles(signedDir).filter((path) => basename(path) === expectedName);
  if (matches.length === 0) fail(`SignPath output does not contain ${expectedName}`);
  if (matches.length > 1) fail(`SignPath output contains multiple ${expectedName} files`);
  return matches[0];
}

export function replaceInstallerCopy(source, destination) {
  if (existsSync(destination)) rmSync(destination, { force: true });
  copyFileSync(source, destination);
}

export function applySignedWindowsInstaller({ packageManifestPath, signedDir, signUpdater }) {
  if (!existsSync(packageManifestPath))
    fail(`PACKAGE_RELEASE.json missing: ${packageManifestPath}`);
  const manifest = JSON.parse(readFileSync(packageManifestPath, "utf8"));
  if (manifest.status !== "ok") fail(`refusing a ${manifest.status} package:release run`);
  const sourceInstaller = manifest.sourceInstaller;
  const acceptedInstaller = manifest.primaryInstaller;
  if (!sourceInstaller || !acceptedInstaller) fail("package manifest is missing installer paths");
  const signedInstaller = findSignedInstaller(signedDir, basename(sourceInstaller));
  replaceInstallerCopy(signedInstaller, sourceInstaller);
  replaceInstallerCopy(signedInstaller, acceptedInstaller);
  if (typeof signUpdater !== "function") fail("signUpdater callback is required");
  signUpdater(sourceInstaller);
  const signaturePath = `${sourceInstaller}.sig`;
  if (!existsSync(signaturePath) || readFileSync(signaturePath, "utf8").trim() === "") {
    fail(`updater signature missing after resigning: ${signaturePath}`);
  }
  const hash = sha256File(acceptedInstaller);
  if (sha256File(sourceInstaller) !== hash)
    fail("signed source and accepted installer hashes differ");
  const next = {
    ...manifest,
    primaryInstallerSha256: hash,
    sourceInstallerSha256: hash,
    updaterBundleSha256: manifest.updaterBundle ? manifest.updaterBundleSha256 : hash,
    authenticode: {
      kind: "signpath",
      trustedPublisher: true,
      files: [{ path: sourceInstaller, kind: "signpath" }],
    },
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(packageManifestPath, `${JSON.stringify(next, null, 2)}\n`);
  return { ...next, signedInstaller, signaturePath };
}

function defaultSignUpdater(installerPath, root) {
  try {
    signUpdaterBundle(installerPath, root);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
}

function main() {
  const args = process.argv.slice(2);
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const signedDir = readArg(args, "--signed-dir") ?? fail("--signed-dir is required");
  const packageManifestPath =
    readArg(args, "--manifest") ??
    join(root, "apps/desktop/src-tauri/target/release-staging/PACKAGE_RELEASE.json");
  const result = applySignedWindowsInstaller({
    packageManifestPath,
    signedDir,
    signUpdater: (installerPath) => defaultSignUpdater(installerPath, root),
  });
  console.log(
    `[apply-windows-signpath] signed ${basename(result.sourceInstaller)} sha256=${result.primaryInstallerSha256}`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
