/**
 * Host environment sandbox — the self-sealing isolation layer.
 *
 * The bundled SDK resolves its global directories through `getAgentDir()`,
 * which re-reads `PI_CODING_AGENT_DIR` on every call (sessions, auth storage,
 * keybindings, models store, skills, extension loader, managed fd/rg binaries,
 * debug log). Some SDK constants are even captured while modules evaluate, so
 * the seal MUST run before any `@earendil-works/pi-coding-agent` module is
 * imported. Keep `./env-sandbox.js` as the FIRST import of the Host entry
 * (`main.ts`): ESM evaluates imports depth-first in declaration order, so the
 * SDK tree only loads after the seal has finished.
 *
 * Sealing means three things:
 * 1. Resolve the isolated agent dir: `--agent-dir=` CLI arg first, then an
 *    injected `PI_CODING_AGENT_DIR`, then `~/.MatrixAgent`. An external Pi CLI
 *    directory (`~/.pi/agent`) is rejected in every position.
 * 2. Delete every inherited `PI_*` variable. A Pi CLI shell environment (session
 *    identity such as `PI_SESSION_FILE`/`PI_SESSION_ID`, model picks such as
 *    `PI_PROVIDER`/`PI_MODEL`/`PI_REASONING_LEVEL`, `PI_OFFLINE`,
 *    `PI_PACKAGE_DIR`, `PI_CODING_AGENT_SESSION_DIR`, ...) must not leak into
 *    the Host. `PIDECK_*` does not match the `PI_` prefix and survives.
 * 3. Pin `PI_CODING_AGENT_DIR` to the isolated dir so every SDK fallback
 *    resolves inside the app's own data directory — even call sites that forget
 *    to pass `agentDir` explicitly, and even if a future SDK version drops the
 *    explicit parameter somewhere.
 */
import { resolveIsolatedAgentDir } from "./pideck-data.js";

const AGENT_DIR_ARG = "--agent-dir=";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

function argAgentDir(argv: readonly string[]): string | null {
  const arg = argv.find((a) => a.startsWith(AGENT_DIR_ARG));
  return arg ? arg.slice(AGENT_DIR_ARG.length) : null;
}

/**
 * True when this process runs the Host entry itself (`node main.js` / `tsx
 * src/main.ts`). Only then does the import-time seal fire — test runners and
 * helper scripts that merely import this module keep full control of their own
 * `PI_*` state (a spawned integration Host must seal even if the parent vitest
 * process leaked `VITEST` into its environment).
 */
function isHostEntryProcess(argv: readonly string[]): boolean {
  const entry = argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/gu, "/").toLowerCase();
  return normalized.endsWith("/main.ts") || normalized.endsWith("/main.js");
}

/**
 * Resolve the isolated agent dir from argv/env without mutating anything.
 * Exported for tests; the Host entry only consumes {@link sealedAgentDir}.
 */
export function resolveSealedAgentDir(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveIsolatedAgentDir({
    envDir: env[PI_AGENT_DIR_ENV] ?? null,
    argDir: argAgentDir(argv),
  });
}

/**
 * Rewrite `env` in place: every inherited `PI_*` variable is deleted, then
 * `PI_CODING_AGENT_DIR` is pinned to `agentDir`. Returns the removed names.
 * Idempotent; safe to call after a previous seal.
 */
export function sealPiEnvironment(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key === PI_AGENT_DIR_ENV) continue;
    if (key.length >= 3 && key.slice(0, 3).toUpperCase() === "PI_") {
      delete env[key];
      removed.push(key);
    }
  }
  env[PI_AGENT_DIR_ENV] = agentDir;
  return removed;
}

let sealedAgentDirValue: string | null = null;

/**
 * The sealed agent dir. The first call resolves it from argv/env, seals the
 * process environment, and memoizes the result; later calls re-pin (so a test
 * or caller that rewrites `PI_CODING_AGENT_DIR` cannot desync the seal) and
 * return the same dir.
 */
export function sealedAgentDir(argv: readonly string[] = process.argv): string {
  if (sealedAgentDirValue === null) {
    sealedAgentDirValue = resolveSealedAgentDir(argv);
  }
  sealPiEnvironment(sealedAgentDirValue);
  return sealedAgentDirValue;
}

/** Test-only: forget the memoized seal so another argv/env can be sealed. */
export function resetSealedAgentDirForTests(): void {
  sealedAgentDirValue = null;
}

// Entry-order seal: this module must be imported first by the Host entry, so
// this runs before any SDK module captures a path. It fires only when the
// process actually runs the Host entry (see isHostEntryProcess) — fixtures and
// helper scripts that import this module call the exported helpers themselves.
if (isHostEntryProcess(process.argv)) {
  const agentDir = sealedAgentDir();
  process.stderr.write(`[pideck] pi environment sealed for ${agentDir}\n`);
}
