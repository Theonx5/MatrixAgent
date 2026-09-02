import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  MATRIX_DEFAULT_POLL_INTERVAL_MIN,
  MATRIX_MAX_POLL_INTERVAL_MIN,
  MATRIX_MIN_POLL_INTERVAL_MIN,
  type MatrixUser,
} from "@pideck/protocol";
import { matrixAuthPath, matrixLibraryRoot, matrixSettingsPath } from "../pideck-data.js";

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export type MatrixAuthRecord = {
  user: MatrixUser;
  token: string;
  issuedAt: string;
  rememberPassword: boolean;
};

export type MatrixSettingsRecord = {
  libraryRoot: string;
  pollIntervalMin: number;
  withAbstract: boolean;
};

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null | undefined)?.code;
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await chmod(path, DIR_MODE);
}

async function writeAtomic(path: string, content: string, mode = FILE_MODE): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(tempPath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    if (process.platform !== "win32") await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    if (errnoCode(error) === "EEXIST" || errnoCode(error) === "EPERM") {
      await unlink(path).catch(() => undefined);
      await rename(tempPath, path);
      return;
    }
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

function defaultMatrixSettings(agentDir: string): MatrixSettingsRecord {
  return {
    libraryRoot: matrixLibraryRoot(agentDir),
    pollIntervalMin: MATRIX_DEFAULT_POLL_INTERVAL_MIN,
    withAbstract: true,
  };
}

function textField(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function mapPaperMatrixUser(user: unknown): MatrixUser {
  const record = user && typeof user === "object" ? (user as Record<string, unknown>) : {};
  const username = textField(record.username).trim();
  const id = textField(record.id).trim() || username || "user";
  const displayName =
    textField(record.displayName) || textField(record.display_name) || username || id;
  const role = textField(record.role);
  return {
    id,
    username: username || id,
    displayName,
    role,
    effectiveRole: textField(record.effectiveRole) || textField(record.effective_role) || role,
  };
}

export class MatrixStore {
  constructor(private readonly agentDir: string) {}

  async loadAuth(): Promise<MatrixAuthRecord | null> {
    const parsed = await readJson(matrixAuthPath(this.agentDir));
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<MatrixAuthRecord>;
    if (!value.user || typeof value.token !== "string" || !value.token) return null;
    if (
      typeof value.user.id !== "string" ||
      typeof value.user.username !== "string" ||
      typeof value.user.displayName !== "string"
    ) {
      return null;
    }
    return {
      user: {
        id: value.user.id,
        username: value.user.username,
        displayName: value.user.displayName,
        role: typeof value.user.role === "string" ? value.user.role : "",
        effectiveRole: typeof value.user.effectiveRole === "string" ? value.user.effectiveRole : "",
      },
      token: value.token,
      issuedAt: typeof value.issuedAt === "string" ? value.issuedAt : new Date(0).toISOString(),
      rememberPassword: value.rememberPassword === true,
    };
  }

  async saveAuth(record: MatrixAuthRecord): Promise<void> {
    await writeAtomic(matrixAuthPath(this.agentDir), `${JSON.stringify(record, null, 2)}\n`);
  }

  async clearAuth(): Promise<void> {
    await unlink(matrixAuthPath(this.agentDir)).catch((error) => {
      if (errnoCode(error) !== "ENOENT") throw error;
    });
  }

  async loadSettings(): Promise<MatrixSettingsRecord> {
    const defaults = defaultMatrixSettings(this.agentDir);
    const parsed = await readJson(matrixSettingsPath(this.agentDir));
    if (!parsed || typeof parsed !== "object") return defaults;
    const value = parsed as Partial<MatrixSettingsRecord>;
    const poll =
      typeof value.pollIntervalMin === "number" &&
      Number.isInteger(value.pollIntervalMin) &&
      value.pollIntervalMin >= MATRIX_MIN_POLL_INTERVAL_MIN &&
      value.pollIntervalMin <= MATRIX_MAX_POLL_INTERVAL_MIN
        ? value.pollIntervalMin
        : defaults.pollIntervalMin;
    return {
      libraryRoot:
        typeof value.libraryRoot === "string" && value.libraryRoot.trim()
          ? value.libraryRoot
          : defaults.libraryRoot,
      pollIntervalMin: poll,
      withAbstract: value.withAbstract !== false,
    };
  }

  async saveSettings(record: MatrixSettingsRecord): Promise<void> {
    await writeAtomic(matrixSettingsPath(this.agentDir), `${JSON.stringify(record, null, 2)}\n`);
  }
}
