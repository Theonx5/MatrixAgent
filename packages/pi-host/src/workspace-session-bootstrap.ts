import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { logger } from "./logger.js";
import { sessionStorageDirs } from "./session-storage.js";

export type WorkspaceSessionBootstrap = {
  sessionPath?: string;
  continueRecent?: boolean;
};

export function sessionPathsEqual(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

/**
 * Startup preload should reopen the last Session instead of minting an empty
 * one. Interactive workspace switches keep creating a fresh Session.
 *
 * `SessionManager.open(path, undefined, cwdOverride)` does not check the file
 * header cwd, so a stale lastSessionPath from another Workspace must be
 * rejected the same way interactive `session.open` does: only paths returned
 * by `SessionManager.list(canonicalCwd)` are eligible.
 *
 * Every static SessionManager call receives the explicit session dir derived
 * from `agentDir`. The SDK would otherwise fall back to its own
 * `getAgentDir()` environment resolution, which can point at an external Pi
 * CLI workspace (`~/.pi/agent`) — sessions must never leak there.
 */
export async function createWorkspaceSessionManager(
  agentDir: string,
  canonicalCwd: string,
  bootstrap: WorkspaceSessionBootstrap = {},
): Promise<SessionManager> {
  const activeDir = sessionStorageDirs(agentDir, canonicalCwd).activeDir;
  if (bootstrap.sessionPath) {
    try {
      if (existsSync(bootstrap.sessionPath)) {
        const listed = await SessionManager.list(canonicalCwd, activeDir);
        const match = listed.find((session) =>
          sessionPathsEqual(session.path, bootstrap.sessionPath!),
        );
        if (match) {
          return SessionManager.open(bootstrap.sessionPath, undefined, canonicalCwd);
        }
        logger.warn("preload session path is not in the current workspace", {
          sessionPath: bootstrap.sessionPath,
        });
      } else {
        logger.warn("preload session path is missing", { sessionPath: bootstrap.sessionPath });
      }
    } catch (err) {
      logger.warn("preload session open failed", {
        sessionPath: bootstrap.sessionPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (bootstrap.continueRecent) {
    return SessionManager.continueRecent(canonicalCwd, activeDir);
  }
  return SessionManager.create(canonicalCwd, activeDir);
}
