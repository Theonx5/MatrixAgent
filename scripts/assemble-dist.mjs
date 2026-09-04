/** Assemble the server dist layout from one platform's staged assets.
 *
 * Two-platform versions evolve independently (Windows via local
 * `pnpm release:local` with v* tags, macOS via CI with agent-v* tags), so the
 * update feed is assembled per platform and MERGED with the live feed:
 *
 * 1. Seed from the live latest.json (404 on first release -> no seed).
 * 2. Place this build's platform entry (signature/url/version/notes).
 * 3. Keep every other platform entry verbatim — its version, notes and URL
 *    are untouched, so the other platform's channel never regresses.
 * 4. Top-level version = max of the platform entry versions (numeric semver
 *    compare); notes/pub_date describe this release.
 *
 * Layout (additive only — old version directories are never deleted):
 *   {target}/latest.json
 *   {target}/v{version}/<installer>            (first install)
 *   {target}/v{version}/<updater> + .sig       (updater entry)
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORM_WINDOWS = "windows-x86_64";
const PLATFORM_MACOS = "darwin-aarch64";

class AssembleDistError extends Error {}

function fail(message) {
  throw new AssembleDistError(message);
}

export function classifyUpdateAsset(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith(".sig")) return null;
  if (lower.endsWith(".exe")) return { platform: PLATFORM_WINDOWS, kind: "installer" };
  if (lower.endsWith(".app.tar.gz") && lower.includes("aarch64")) {
    return { platform: PLATFORM_MACOS, kind: "updater" };
  }
  if (lower.endsWith(".dmg") && lower.includes("aarch64")) {
    return { platform: PLATFORM_MACOS, kind: "installer" };
  }
  return null;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Windows-safe copy-over: writing straight onto an existing (possibly held)
 * file raises EPERM — stage a temp copy, then rename, clearing the target
 * with an unlink retry when needed (same pattern as the credential store).
 */
function copyFileAtomic(source, destination) {
  const temp = `${destination}.${randomUUID()}.tmp`;
  copyFileSync(source, temp);
  try {
    chmodSync(temp, 0o666);
    renameSync(temp, destination);
  } catch (error) {
    const code = error?.code;
    if (code === "EPERM" || code === "EEXIST") {
      // A read-only attribute on the target blocks unlink on Windows — clear
      // it before removing, then retry the atomic swap.
      try {
        chmodSync(destination, 0o666);
      } catch {
        /* nothing to clear */
      }
      rmSync(destination, { force: true });
      chmodSync(temp, 0o666);
      renameSync(temp, destination);
      return;
    }
    rmSync(temp, { force: true });
    throw error;
  }
}

function assertAssetName(name, label) {
  if (typeof name !== "string" || name.length === 0 || name.includes("/") || name.includes("\\")) {
    fail(`invalid ${label}: ${String(name)}`);
  }
}

/** Numeric semver compare: -1/0/1 on [major, minor, patch]. */
export function semverCompare(a, b) {
  const pa = String(a ?? "")
    .split(".")
    .map((part) => Number(part) || 0);
  const pb = String(b ?? "")
    .split(".")
    .map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function maxPlatformVersion(platforms) {
  const versions = Object.values(platforms)
    .map((entry) => entry?.version)
    .filter((version) => typeof version === "string" && /^\d+\.\d+\.\d+$/u.test(version));
  if (versions.length === 0) return null;
  return versions.reduce(
    (max, version) => (semverCompare(version, max) > 0 ? version : max),
    versions[0],
  );
}

/**
 * Merge one platform's freshly staged entries into the live feed. `staged` is
 * the full new entry for this platform; seed entries for OTHER platforms are
 * preserved verbatim so their version/notes/URL never regress.
 */
export function mergePlatformEntry(live, platform, staged, release = {}) {
  const platforms = { ...(live?.platforms ?? {}) };
  platforms[platform] = staged;
  const version = maxPlatformVersion(platforms) ?? staged.version;
  return {
    version,
    pub_date: release.pubDate,
    notes: release.notes,
    platforms,
  };
}

/** Collect update entries and installers from the staged dir. */
export function collectPlatformAssets(assetsDir) {
  if (!existsSync(assetsDir)) fail(`staged assets directory is missing: ${assetsDir}`);
  const update = new Map();
  const installers = [];
  for (const name of readdirSync(assetsDir)) {
    const classified = classifyUpdateAsset(name);
    if (!classified) continue;
    const path = join(assetsDir, name);
    if (classified.kind === "installer") {
      installers.push({ name, path, platform: classified.platform });
      // Windows' updater bundle IS the NSIS installer itself.
      if (classified.platform === PLATFORM_WINDOWS) {
        const signaturePath = `${path}.sig`;
        if (!existsSync(signaturePath)) fail(`updater signature missing for ${name}`);
        update.set(classified.platform, {
          name,
          path,
          signaturePath,
          signature: readFileSync(signaturePath, "utf8").trim(),
        });
      }
      continue;
    }
    const signaturePath = `${path}.sig`;
    if (!existsSync(signaturePath)) fail(`updater signature missing for ${name}`);
    update.set(classified.platform, {
      name,
      path,
      signaturePath,
      signature: readFileSync(signaturePath, "utf8").trim(),
    });
  }
  return { update, installers };
}

export function buildDistManifest(options) {
  const { version, platform, assetsDir, baseUrl, notes, pubDate, live } = options;
  const { update } = collectPlatformAssets(assetsDir);
  const entry = update.get(platform);
  if (!entry) {
    fail(
      `no updater bundle for ${platform} in ${assetsDir} — the build must produce an updater asset with a signature`,
    );
  }
  if (!entry.signature) fail(`updater signature is empty for ${platform}`);
  const staged = {
    signature: entry.signature,
    url: `${baseUrl.replace(/\/$/, "")}/api/updates/matrix-agent/files/v${version}/${entry.name}`,
    version,
    notes,
  };
  const manifest = mergePlatformEntry(live, platform, staged, { notes, pubDate });
  if (!manifest.version) fail("assembled manifest has no version");
  return { manifest, entry };
}

/** Copy the staged assets into dist/v{version}/ and write latest.json. */
function assembleDist(options) {
  const { version, assetsDir, target } = options;
  const { manifest, entry } = buildDistManifest(options);
  const versionDir = join(target, `v${version}`);
  mkdirSync(versionDir, { recursive: true });

  const { installers } = collectPlatformAssets(assetsDir);
  for (const installer of installers) {
    assertAssetName(installer.name, "installer");
    copyFileAtomic(installer.path, join(versionDir, installer.name));
  }
  copyFileAtomic(entry.path, join(versionDir, entry.name));
  copyFileAtomic(entry.signaturePath, join(versionDir, `${entry.name}.sig`));

  const latestPath = join(target, "latest.json");
  writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { latestPath, versionDir, manifest, target };
}

/** ---- CLI ---- */

function parseCliArgs(argv) {
  const args = {
    artifacts: null,
    version: null,
    platform: null,
    baseUrl: "https://papermatrix.online",
    target: null,
    notes: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index];
    if (value === "--artifacts") args.artifacts = next();
    else if (value === "--version") args.version = next();
    else if (value === "--platform") args.platform = next();
    else if (value === "--base-url") args.baseUrl = next();
    else if (value === "--target") args.target = next();
    else if (value === "--notes") args.notes = next();
    else fail(`unknown argument: ${value}`);
  }
  if (!args.artifacts) fail("--artifacts is required");
  if (!args.version) fail("--version is required");
  if (!args.platform) fail("--platform is required (windows-x86_64 | darwin-aarch64)");
  if (!args.target) fail("--target is required");
  return args;
}

/** Seed for the merge: the live feed, or null on first release / network loss. */
async function readLiveLatest(baseUrl) {
  try {
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/api/updates/matrix-agent/latest.json`,
      {
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) return null;
    return (await response.json()) ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const live = await readLiveLatest(args.baseUrl);
  const pubDate = new Date().toISOString();
  const result = assembleDist({
    version: args.version,
    platform: args.platform,
    assetsDir: resolve(args.artifacts),
    baseUrl: args.baseUrl,
    notes: args.notes,
    pubDate,
    live,
    target: resolve(args.target),
  });
  console.log(`[assemble-dist] latest.json version ${result.manifest.version}`);
  for (const [platform, entry] of Object.entries(result.manifest.platforms)) {
    const label = entry.version ? `v${entry.version}` : "legacy entry (no version field)";
    console.log(`[assemble-dist]   ${platform}: ${label} -> ${entry.url}`);
  }
  console.log(`[assemble-dist] dist assembled at ${result.target}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
