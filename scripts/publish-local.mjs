/** Local Windows release: build, stage, assemble the dist layout, deploy over SSH.
 *
 * Two-track release policy:
 * - patch releases (0.2.6 -> 0.2.7): built on the release machine (this script)
 *   and pushed straight to papermatrix.online — Windows only, no GitHub Actions.
 * - major/minor releases (0.2.x -> 0.3.0, 1.x): tagged as usual; the GitHub
 *   Actions "Release desktop installers" workflow builds Windows + macOS.
 *
 * Usage:
 *   node scripts/publish-local.mjs [--tag vX.Y.Z] [--notes "..."] [--skip-build]
 *        [--base-url https://papermatrix.online] [--target artifacts/release-dist]
 *        [--server host] [--user name] [--port 22] [--dist-dir /path/on/server]
 *        [--no-deploy] [--no-merge-remote] [--python python]
 *
 * Deploy target resolution order: CLI flag > env (DEPLOY_SERVER_HOST /
 * DEPLOY_SERVER_USER / DEPLOY_DIST_DIR / DEPLOY_SSH_PORT) > ~/.ssh/config for
 * the host. Auth uses the local SSH agent / key, exactly like a manual ssh.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export class PublishLocalError extends Error {}

/** Raises a user-facing failure; main() prints it and exits non-zero. */
function fail(message) {
  throw new PublishLocalError(`[publish-local] ${message}`);
}

function info(message) {
  console.log(`[publish-local] ${message}`);
}

export function parseArgs(argv) {
  const args = {
    tag: null,
    notes: "",
    base: "https://papermatrix.online",
    target: join(root, "artifacts", "release-dist"),
    server: process.env.DEPLOY_SERVER_HOST ?? "192.168.3.13",
    user: process.env.DEPLOY_SERVER_USER ?? "theonx",
    port: process.env.DEPLOY_SSH_PORT ?? "22",
    distDir:
      process.env.DEPLOY_DIST_DIR ?? "/home/theonx/servers-PaperDownload-prod/matrix-agent_dist",
    skipBuild: false,
    deploy: true,
    mergeRemote: true,
    allowDirty: false,
    keyPassword: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = () => argv[++index];
    if (value === "--tag") args.tag = next();
    else if (value === "--notes") args.notes = next();
    else if (value === "--base-url") args.base = next();
    else if (value === "--target") args.target = next();
    else if (value === "--server") args.server = next();
    else if (value === "--user") args.user = next();
    else if (value === "--port") args.port = next();
    else if (value === "--dist-dir") args.distDir = next();
    else if (value === "--skip-build") args.skipBuild = true;
    else if (value === "--no-deploy") args.deploy = false;
    else if (value === "--no-merge-remote") args.mergeRemote = false;
    else if (value === "--allow-dirty") args.allowDirty = true;
    else if (value === "--key-password") args.keyPassword = next();
    else fail(`unknown argument: ${value}`);
  }
  return args;
}

/** v-prefixed semver guard; returns the tag unchanged when valid. */
export function normalizeTag(tag) {
  if (!/^v\d+\.\d+\.\d+$/u.test(String(tag ?? ""))) {
    fail(`tag must look like v<semver> (e.g. v0.2.7), got ${String(tag)}`);
  }
  return tag;
}

/** Read the app version from tauri.conf.json — the file the update feed validates against. */
export function readAppVersion(rootDir = root) {
  const config = JSON.parse(
    readFileSync(join(rootDir, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  const version = config.version;
  if (!/^\d+\.\d+\.\d+$/u.test(String(version ?? ""))) {
    fail(`tauri.conf.json has no valid version field: ${String(version)}`);
  }
  return version;
}

function run(label, command, args, options = {}) {
  console.log(`\n[publish-local] === ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32" && command === "pnpm",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) fail(`${label} failed (exit ${result.status ?? "?"})`);
}

function assertCleanTree(allowDirty) {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) fail("git status failed — run inside the repository");
  if (result.stdout.trim() && !allowDirty) {
    fail(
      "working tree is dirty; commit or stash first (the updater must be traceable to a commit), or pass --allow-dirty",
    );
  }
}

/**
 * Ensure the updater signing material is usable without interactive prompts.
 * Encrypted (rsign) keys require TAURI_SIGNING_PRIVATE_KEY_PASSWORD — without
 * it tauri build hangs waiting on a password prompt that never gets input.
 */
export function ensureUpdaterKey(rootDir = root) {
  if (process.env.TAURI_SIGNING_PRIVATE_KEY) return;
  const keyPath = join(rootDir, "apps/desktop/src-tauri/.tauri-updater.key");
  if (!existsSync(keyPath)) {
    fail(
      "TAURI_SIGNING_PRIVATE_KEY is not set and apps/desktop/src-tauri/.tauri-updater.key is missing — the updater bundle cannot be signed",
    );
  }
  const keyContent = readFileSync(keyPath, "utf8");
  // Key files store a base64'd comment line; decoding it reveals whether the
  // key is rsign-encrypted ("...rsign encrypted secret key").
  let encrypted = false;
  try {
    const firstLine = keyContent.split(/\r?\n/, 1)[0] ?? "";
    const decoded = Buffer.from(firstLine, "base64").toString("utf8");
    encrypted = /rsign encrypted|minisign encrypted/i.test(decoded);
  } catch {
    encrypted = false;
  }
  if (encrypted && !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    fail(
      "the updater key is password-protected — set TAURI_SIGNING_PRIVATE_KEY_PASSWORD (or pass --key-password)",
    );
  }
  process.env.TAURI_SIGNING_PRIVATE_KEY = keyContent;
  info(
    encrypted
      ? "loaded password-protected updater signing key from .tauri-updater.key"
      : "loaded updater signing key from .tauri-updater.key",
  );
}

function stagedAssetsDir() {
  return join(root, "apps/desktop/src-tauri/target/release-staging/github-release-platform");
}

function deployTarget(args) {
  if (!args.server || !args.user || !args.distDir) {
    fail(
      "deploy target incomplete — pass --server/--user/--dist-dir or set DEPLOY_SERVER_HOST / DEPLOY_SERVER_USER / DEPLOY_DIST_DIR (DEPLOY_SSH_PORT optional)",
    );
  }
  return { host: args.server, user: args.user, port: args.port, distDir: args.distDir };
}

function sshArgs(target, remoteCommand) {
  return [
    "-p",
    target.port,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "BatchMode=yes",
    `${target.user}@${target.host}`,
    remoteCommand,
  ];
}

function deploy(distDir, version, target) {
  const versionDirName = `v${version}`;
  const localVersionDir = join(distDir, versionDirName);
  if (!existsSync(localVersionDir)) fail(`assembled dist is missing ${localVersionDir}`);
  info(
    `deploying ${versionDirName} + latest.json to ${target.user}@${target.host}:${target.distDir}`,
  );
  run(
    "remote dist dir",
    "ssh",
    sshArgs(target, `mkdir -p ${JSON.stringify(`${target.distDir}/${versionDirName}`)}`),
  );
  // 只增不删: never touch other version directories — they stay for rollback.
  for (const name of ["latest.json", ...readdirFiles(localVersionDir)]) {
    const isFeed = name === "latest.json";
    const local = join(isFeed ? distDir : localVersionDir, name);
    const remoteDir = isFeed ? target.distDir : `${target.distDir}/${versionDirName}`;
    run(`upload ${name}`, "scp", [
      "-P",
      target.port,
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      local,
      `${target.user}@${target.host}:${remoteDir}/${name}`,
    ]);
  }
}

function readdirFiles(dir) {
  return readdirSync(dir).filter((name) => statSync(join(dir, name)).isFile());
}

function selfCheck(base, version) {
  info(`self check ${base}/api/updates/matrix-agent/latest.json`);
  const result = spawnSync("curl", ["-fsS", `${base}/api/updates/matrix-agent/latest.json`], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) fail(`self check request failed (exit ${result.status})`);
  if (!result.stdout.includes(`"version": "${version}"`)) {
    fail(`self check: latest.json does not report version ${version} yet`);
  }
  info(`publish OK: ${version}`);
}

async function main() {
  try {
    await runRelease(process.argv.slice(2));
  } catch (error) {
    if (error instanceof PublishLocalError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

async function runRelease(argv) {
  const args = parseArgs(argv);
  const appVersion = readAppVersion();
  const tag = args.tag ? normalizeTag(args.tag) : `v${appVersion}`;
  if (args.tag && tag !== `v${appVersion}`) {
    fail(
      `tag ${tag} does not match tauri.conf.json version ${appVersion} — bump the version files first`,
    );
  }
  const version = appVersion;
  info(`releasing ${version} (${tag}) — Windows x64, local build`);

  if (process.platform !== "win32") {
    fail(
      "local release packaging supports Windows x64 only; tag a major/minor bump for the dual-platform CI build",
    );
  }
  if (process.versions.node && Number(process.versions.node.split(".")[0]) < 24) {
    info(
      `warning: running on Node ${process.versions.node}; the CI release gate uses Node 24 (.node-version)`,
    );
  }
  assertCleanTree(args.allowDirty);
  if (args.keyPassword && !process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = args.keyPassword;
  }
  ensureUpdaterKey();

  const staging = join(root, "apps/desktop/src-tauri/target/release-staging");
  if (!args.skipBuild) {
    rmSync(staging, { recursive: true, force: true });
    run("build NSIS installer + updater bundle", "pnpm", ["package:release"], {
      env: { RELEASE_TAG: tag },
    });
  } else {
    info("skipping build (--skip-build), reusing the existing staging output");
  }
  run("stage platform assets", "node", [
    "scripts/generate-update-manifest.mjs",
    "--stage-platform",
    "--tag",
    tag,
  ]);

  const assets = stagedAssetsDir();
  if (!existsSync(assets)) fail(`staged assets missing: ${assets}`);
  const distDir = resolve(args.target);
  mkdirSync(distDir, { recursive: true });
  run("assemble dist (latest.json + version dir)", args.python, [
    "scripts/publish.py",
    "--artifacts",
    assets,
    "--version",
    version,
    "--base-url",
    args.base,
    "--target",
    distDir,
    "--notes",
    args.notes || `PaperMatrix ${tag}`,
  ]);

  if (args.mergeRemote) {
    const latestPath = join(distDir, "latest.json");
    const local = JSON.parse(readFileSync(latestPath, "utf8"));
    const live = await fetchLiveLatestJson(args.base);
    if (live && live.version !== version) {
      const merged = mergeRemotePlatforms(live, local);
      writeFileSync(latestPath, `${JSON.stringify(merged, null, 2)}\n`);
      info(
        `merged remote platforms from ${live.version}: ${Object.keys(merged.platforms).join(", ")}`,
      );
    } else {
      info("remote feed absent or already at this version — no platform merge needed");
    }
  }

  if (!args.deploy) {
    info(`--no-deploy: dist assembled at ${distDir}`);
    return;
  }
  const target = deployTarget(args);
  deploy(distDir, version, target);
  selfCheck(args.base, version);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
