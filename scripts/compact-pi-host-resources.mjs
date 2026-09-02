/**
 * Pack the Pi Host runtime and node_modules into one archive for NSIS MAX_PATH
 * safety (C1/C8). main.js materializes that signed payload in a versioned,
 * writable cache and runs the cached Host entry.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  detachNodeModulesLinks,
  restoreNodeModulesLinks,
  snapshotNodeModulesGraph,
} from "./portable-node-modules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostDir = join(root, "apps/desktop/src-tauri/resources/pi-host");
const nm = join(hostDir, "node_modules");
const archiveName = "node_modules.tar.gz";
const archivePath = join(hostDir, archiveName);
const legacyZipPath = join(hostDir, "node_modules.zip");
const linksPath = join(hostDir, "NODE_MODULES_LINKS.json");
const graphPath = join(hostDir, "NODE_MODULES_GRAPH.json");
const portableHelperSource = join(root, "scripts/portable-node-modules.mjs");
const portableHelperPath = join(hostDir, "portable-node-modules.mjs");
const bootstrapRuntimeSource = join(root, "scripts/pi-host-bootstrap-runtime.mjs");
const bootstrapRuntimePath = join(hostDir, "pi-host-bootstrap-runtime.mjs");
const hostRuntimePayload = join(hostDir, "host-runtime");
const MIN_ARCHIVE_BYTES = 1_000_000; // real SDK tree is tens of MB
const HOST_PAYLOAD_FORMAT = "pax-gzip";

function die(msg) {
  console.error("[compact]", msg);
  process.exit(1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Windows ships bsdtar at System32\tar.exe (supports -a zip and drive-letter
// paths). A bare "tar.exe" can resolve to Git for Windows' GNU tar on PATH,
// which treats C:\ as a remote host and cannot write zip — always prefer the
// absolute System32 binary.
function windowsBsdTar() {
  const systemTar = process.env.SystemRoot
    ? join(process.env.SystemRoot, "System32", "tar.exe")
    : null;
  return systemTar && existsSync(systemTar) ? systemTar : "tar.exe";
}

function tarBin() {
  return process.platform === "win32" ? windowsBsdTar() : "tar";
}

function createNodeModulesArchive() {
  // Windows tar -a zip round-trips drop files (libarchive ZIP decompression -5),
  // which then crashes the staged Host on undici's lib/util/date.js. pax+gzip
  // extracts with the same tar.exe.
  return spawnSync(
    tarBin(),
    [
      "--format",
      "pax",
      "-c",
      "-z",
      "-f",
      archivePath,
      "-C",
      hostDir,
      "node_modules",
      "host-runtime",
    ],
    { encoding: "utf8", shell: false },
  );
}

function extractNodeModulesArchive(destination) {
  mkdirSync(destination, { recursive: true });
  return spawnSync(tarBin(), ["-x", "-z", "-f", archivePath, "-C", destination], {
    encoding: "utf8",
    shell: false,
  });
}

function verifyExtractedArchive(linksManifest) {
  const verifyDir = join(hostDir, ".compact-verify");
  rmSync(verifyDir, { recursive: true, force: true });
  try {
    const extracted = extractNodeModulesArchive(verifyDir);
    if (extracted.status !== 0) {
      throw new Error(
        `archive extract verify failed: ${
          extracted.stderr || extracted.stdout || extracted.error?.message || extracted.status
        }`,
      );
    }
    restoreNodeModulesLinks(join(verifyDir, "node_modules"), linksManifest);
    const undiciDate = join(verifyDir, "node_modules", "undici", "lib", "util", "date.js");
    if (!existsSync(undiciDate)) {
      throw new Error("extracted undici is missing lib/util/date.js");
    }
    const prove = spawnSync(
      process.execPath,
      [
        "-e",
        "import('undici').then(()=>console.log('UNDICI_OK')).catch((error)=>{console.error(error);process.exit(1)})",
      ],
      { cwd: verifyDir, encoding: "utf8", shell: false },
    );
    if (prove.status !== 0 || !(prove.stdout || "").includes("UNDICI_OK")) {
      throw new Error(`extracted undici import failed: ${prove.stderr || prove.stdout || prove.status}`);
    }
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

function copyHostRuntimeTree(source, destination, isRoot = false, copyAll = false) {
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    if (
      isRoot &&
      ["main.js", "node_modules", "host-runtime", "vendor", ".compact-verify", archiveName].includes(
        name,
      )
    )
      continue;
    const from = join(source, name);
    const to = join(destination, name);
    const stats = statSync(from);
    const nextCopyAll = copyAll || name === "resources";
    if (stats.isDirectory()) {
      copyHostRuntimeTree(from, to, false, nextCopyAll);
      continue;
    }
    if (
      nextCopyAll ||
      (isRoot && name === "package.json") ||
      name === "host-main.js" ||
      name.endsWith(".js") ||
      name.endsWith(".js.map")
    ) {
      copyFileSync(from, to);
    }
  }
}

if (!existsSync(join(hostDir, "main.js")) && !existsSync(join(hostDir, "host-main.js"))) {
  die("pi-host main.js missing — run package:sidecar first");
}
const mainJs = join(hostDir, "main.js");
const hostMain = join(hostDir, "host-main.js");
if (!existsSync(hostMain)) {
  if (!existsSync(mainJs)) die("no main.js to rename");
  const currentMain = readFileSync(mainJs, "utf8");
  if (
    (currentMain.includes("node_modules.tar.gz") && currentMain.includes("host-main.js")) ||
    currentMain.includes("pi-host-bootstrap-runtime.mjs") ||
    currentMain.includes("PIDECK_HOST_CACHE_DIR")
  ) {
    die("host-main.js missing but main.js is already bootstrap — re-run package:sidecar");
  }
  renameSync(mainJs, hostMain);
}
copyFileSync(portableHelperSource, portableHelperPath);
copyFileSync(bootstrapRuntimeSource, bootstrapRuntimePath);

// Zip if missing or too small
const stagingPath = join(hostDir, "STAGING.json");
const priorStaging = existsSync(stagingPath) ? JSON.parse(readFileSync(stagingPath, "utf8")) : {};
if (existsSync(legacyZipPath)) rmSync(legacyZipPath, { force: true });
const archiveOk =
  existsSync(archivePath) &&
  statSync(archivePath).size >= MIN_ARCHIVE_BYTES &&
  priorStaging.hostRuntimePackagedInZip === true &&
  priorStaging.hostPayloadFormat === HOST_PAYLOAD_FORMAT;
if (!archiveOk) {
  if (!existsSync(nm)) die("node_modules missing and no valid host payload archive");
  if (existsSync(archivePath)) rmSync(archivePath, { force: true });
  let detached;
  try {
    rmSync(hostRuntimePayload, { recursive: true, force: true });
    copyHostRuntimeTree(hostDir, hostRuntimePayload, true);
    if (
      !existsSync(join(hostRuntimePayload, "host-main.js")) ||
      !existsSync(join(hostRuntimePayload, "package.json"))
    ) {
      throw new Error("host-runtime cache payload is incomplete");
    }
    const releasePackage = JSON.parse(readFileSync(join(hostDir, "package.json"), "utf8"));
    const dependencyGraph = snapshotNodeModulesGraph(nm, releasePackage.dependencies);
    writeFileSync(graphPath, `${JSON.stringify(dependencyGraph, null, 2)}\n`);
    detached = detachNodeModulesLinks(nm);
    writeFileSync(linksPath, `${JSON.stringify(detached.manifest, null, 2)}\n`);
    console.log(
      "[compact] creating node_modules.tar.gz from portable pnpm store; links:",
      detached.manifest.links.length,
    );
    const tar = createNodeModulesArchive();
    if (
      tar.status !== 0 ||
      !existsSync(archivePath) ||
      statSync(archivePath).size < MIN_ARCHIVE_BYTES
    ) {
      console.error(tar.stdout ?? "", tar.stderr ?? tar.error?.message ?? "");
      throw new Error(
        `tar gzip failed size=${existsSync(archivePath) ? statSync(archivePath).size : 0}`,
      );
    }
    verifyExtractedArchive(detached.manifest);
  } catch (error) {
    if (detached) {
      try {
        restoreNodeModulesLinks(nm, detached.manifest);
      } catch (restoreError) {
        console.error(
          "[compact] failed to restore node_modules after archive error",
          restoreError instanceof Error ? restoreError.message : String(restoreError),
        );
      }
    }
    rmSync(hostRuntimePayload, { recursive: true, force: true });
    die(error instanceof Error ? error.message : String(error));
  }
  console.log("[compact] archive bytes", statSync(archivePath).size);
} else {
  for (const required of [linksPath, graphPath, portableHelperPath, bootstrapRuntimePath]) {
    if (!existsSync(required)) die(`portable node_modules metadata missing: ${required}`);
  }
  console.log("[compact] reusing existing archive bytes", statSync(archivePath).size);
}

// Remove expanded tree so NSIS only packs one archive file
if (existsSync(nm)) {
  console.log("[compact] removing expanded node_modules...");
  rmSync(nm, { recursive: true, force: true });
}
rmSync(hostRuntimePayload, { recursive: true, force: true });

const bootstrap = `/**
 * Bootstrap: materialize the signed Host payload in a versioned writable cache.
 * Generated by scripts/compact-pi-host-resources.mjs
 */
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiHostBootstrap } from "./pi-host-bootstrap-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cacheRoot = process.env.PIDECK_HOST_CACHE_DIR;
if (!cacheRoot) {
  console.error("[pi-host bootstrap] PIDECK_HOST_CACHE_DIR is required");
  process.exit(1);
}
await runPiHostBootstrap({ resourceDir: __dirname, cacheRoot });
`;

writeFileSync(mainJs, bootstrap);

if (existsSync(stagingPath)) {
  const s = JSON.parse(readFileSync(stagingPath, "utf8"));
  s.nodeModulesPackagedAs = archiveName;
  s.hostPayloadFormat = HOST_PAYLOAD_FORMAT;
  s.bootstrapEntry = "main.js -> versioned writable cache -> cached host-runtime/host-main.js";
  s.hostRuntimePackagedInZip = true;
  s.hostCacheSchemaVersion = 1;
  s.zipBytes = statSync(archivePath).size;
  s.nodeModulesZipSha256 = sha256File(archivePath);
  s.nodeModulesLinks = JSON.parse(readFileSync(linksPath, "utf8")).links.length;
  s.nodeModulesLinksSha256 = sha256File(linksPath);
  s.nodeModulesGraphSha256 = sha256File(graphPath);
  writeFileSync(stagingPath, JSON.stringify(s, null, 2));
}

console.log("[compact] OK — resources ready for NSIS (single tar.gz, no deep node_modules paths)");
