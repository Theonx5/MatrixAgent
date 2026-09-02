import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  MATRIX_DEFAULT_POLL_INTERVAL_MIN,
  MATRIX_MAX_POLL_INTERVAL_MIN,
  MATRIX_MIN_POLL_INTERVAL_MIN,
  createHostError,
  createIdleMatrixStatus,
  idleMatrixSyncProgress,
  type HostError,
  type MatrixProgressPayload,
  type MatrixStatusSnapshot,
  type MatrixSyncProgress,
} from "@pideck/protocol";
import { logger } from "../logger.js";
import { matrixLibraryRoot } from "../pideck-data.js";
import {
  DEFAULT_MATRIX_BASE_URL,
  MatrixApiClient,
  MatrixHttpError,
  matrixErrorFromHttp,
  type MatrixFetch,
} from "./client.js";
import { seedLibrary, seedUserResources } from "./library.js";
import {
  MatrixStore,
  mapPaperMatrixUser,
  type MatrixAuthRecord,
  type MatrixSettingsRecord,
} from "./store.js";
import { createMatrixFetch } from "./fetch.js";
import { MatrixSyncEngine, type SyncRunReason } from "./sync-engine.js";

const TOKEN_BUDGET_PER_MIN = 60;

type MatrixServiceEmit = {
  status: (snapshot: MatrixStatusSnapshot) => void;
  progress: (payload: MatrixProgressPayload) => void;
};

export type MatrixServiceOptions = {
  agentDir: string;
  emit: MatrixServiceEmit;
  fetchImpl?: MatrixFetch;
  baseUrl?: string;
  now?: () => Date;
};

const defaultFetch: MatrixFetch = createMatrixFetch();

export class MatrixService {
  private readonly store: MatrixStore;
  private readonly client: MatrixApiClient;
  private readonly engine: MatrixSyncEngine;
  private settings: MatrixSettingsRecord;
  private auth: MatrixAuthRecord | null = null;
  private lastError: string | null = null;
  private authRequired = false;
  private sync: MatrixSyncProgress;
  private running: Promise<MatrixStatusSnapshot> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 0;
  private stopped = false;
  private tokens = TOKEN_BUDGET_PER_MIN;
  private lastRefill = Date.now();

  constructor(private readonly options: MatrixServiceOptions) {
    this.store = new MatrixStore(options.agentDir);
    this.settings = {
      libraryRoot: matrixLibraryRoot(options.agentDir),
      pollIntervalMin: 30,
      withAbstract: true,
    };
    this.sync = createIdleMatrixStatus(this.settings.libraryRoot).sync;
    this.client = new MatrixApiClient({
      baseUrl: options.baseUrl ?? process.env.PIDECK_MATRIX_BASE_URL ?? DEFAULT_MATRIX_BASE_URL,
      fetch: options.fetchImpl ?? defaultFetch,
      getToken: () => this.auth?.token ?? null,
      takeToken: () => this.takeToken(),
    });
    this.engine = new MatrixSyncEngine(this.client);
  }

  async start(): Promise<void> {
    this.settings = await this.store.loadSettings();
    this.auth = await this.store.loadAuth();
    await mkdir(this.settings.libraryRoot, { recursive: true });
    await seedLibrary(this.settings.libraryRoot);
    await seedUserResources(this.options.agentDir);
  }

  startBackground(): void {
    const timer = setTimeout(() => {
      if (this.stopped) return;
      this.emitStatus();
      if (this.auth) {
        void this.syncNow("startup").catch((error: unknown) => {
          logger.warn("Startup Paper Matrix sync failed", { error: errorMessage(error) });
        });
      } else {
        this.armTimer();
      }
    }, 0);
    timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  status(): MatrixStatusSnapshot {
    const poll = this.settings.pollIntervalMin;
    const phase = this.sync?.phase;
    const idle = idleMatrixSyncProgress();
    return {
      loggedIn: Boolean(this.auth?.token),
      user: this.auth ? mapPaperMatrixUser(this.auth.user) : null,
      rememberPassword: this.auth?.rememberPassword === true,
      authRequired: this.authRequired === true,
      libraryRoot:
        typeof this.settings.libraryRoot === "string" && this.settings.libraryRoot.trim()
          ? this.settings.libraryRoot
          : matrixLibraryRoot(this.options.agentDir),
      pollIntervalMin:
        Number.isInteger(poll) &&
        poll >= MATRIX_MIN_POLL_INTERVAL_MIN &&
        poll <= MATRIX_MAX_POLL_INTERVAL_MIN
          ? poll
          : MATRIX_DEFAULT_POLL_INTERVAL_MIN,
      withAbstract: this.settings.withAbstract !== false,
      lastSyncAt:
        typeof this.lastSyncAt === "string" && this.lastSyncAt.length > 0 ? this.lastSyncAt : null,
      lastError: typeof this.lastError === "string" ? this.lastError : null,
      sync: {
        running: this.sync?.running === true,
        runId: typeof this.sync?.runId === "string" && this.sync.runId ? this.sync.runId : null,
        phase:
          phase === "idle" ||
          phase === "manifest" ||
          phase === "diff" ||
          phase === "fetch" ||
          phase === "index"
            ? phase
            : "idle",
        done: nonNeg(this.sync?.done, idle.done),
        total: nonNeg(this.sync?.total, idle.total),
        currentTitle: typeof this.sync?.currentTitle === "string" ? this.sync.currentTitle : null,
        collections: nonNeg(this.sync?.collections, idle.collections),
        items: nonNeg(this.sync?.items, idle.items),
        downloaded: nonNeg(this.sync?.downloaded, idle.downloaded),
        skipped: nonNeg(this.sync?.skipped, idle.skipped),
        conflicts: nonNeg(this.sync?.conflicts, idle.conflicts),
      },
    };
  }

  settingsSnapshot() {
    return {
      libraryRoot: this.settings.libraryRoot,
      pollIntervalMin: this.settings.pollIntervalMin,
      withAbstract: this.settings.withAbstract,
    };
  }

  async login(
    username: string,
    password: string,
    rememberPassword: boolean,
  ): Promise<MatrixStatusSnapshot> {
    try {
      const result = await this.client.login(username, password);
      this.auth = {
        user: mapPaperMatrixUser(result.user),
        token: result.access_token,
        issuedAt: (this.options.now?.() ?? new Date()).toISOString(),
        rememberPassword,
      };
      this.authRequired = false;
      this.lastError = null;
      await this.store.saveAuth(this.auth);
      this.emitStatus();
      void this.syncNow("startup");
      return this.status();
    } catch (error) {
      this.lastError = errorMessage(error);
      this.emitStatus();
      if (error instanceof MatrixHttpError) throw matrixErrorFromHttp(error);
      throw createHostError("INTERNAL_ERROR", this.lastError, { retryable: true });
    }
  }

  async logout(): Promise<MatrixStatusSnapshot> {
    this.auth = null;
    this.authRequired = false;
    this.lastError = null;
    await this.store.clearAuth();
    this.emitStatus();
    return this.status();
  }

  async patchSettings(patch: {
    libraryRoot?: string;
    pollIntervalMin?: number;
    withAbstract?: boolean;
  }): Promise<MatrixStatusSnapshot> {
    const next = { ...this.settings };
    if (patch.libraryRoot) {
      next.libraryRoot = resolve(patch.libraryRoot);
      await mkdir(next.libraryRoot, { recursive: true });
      await seedLibrary(next.libraryRoot);
    }
    if (patch.pollIntervalMin !== undefined) next.pollIntervalMin = patch.pollIntervalMin;
    if (patch.withAbstract !== undefined) next.withAbstract = patch.withAbstract;
    this.settings = next;
    await this.store.saveSettings(next);
    this.armTimer();
    this.emitStatus();
    return this.status();
  }

  async syncNow(_reason: SyncRunReason = "manual"): Promise<MatrixStatusSnapshot> {
    if (this.running) return this.running;
    if (!this.auth) {
      throw createHostError("AUTH_REQUIRED", "Sign in to Paper Matrix before syncing");
    }
    this.backoffMs = 0;
    this.running = this.runSync();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  private lastSyncAt: string | null = null;

  private async runSync(): Promise<MatrixStatusSnapshot> {
    try {
      const result = await this.engine.run({
        libraryRoot: this.settings.libraryRoot,
        withAbstract: this.settings.withAbstract,
        hooks: {
          onProgress: (sync, payload) => {
            this.sync = {
              ...sync,
              currentTitle: typeof sync.currentTitle === "string" ? sync.currentTitle : null,
            };
            try {
              this.options.emit.progress({
                ...payload,
                currentTitle:
                  typeof payload.currentTitle === "string" ? payload.currentTitle : null,
              });
            } catch (error) {
              logger.error("Failed to publish matrix progress", { error: errorMessage(error) });
            }
          },
        },
      });
      this.sync = result;
      this.lastSyncAt = (this.options.now?.() ?? new Date()).toISOString();
      this.lastError = null;
      this.authRequired = false;
      this.backoffMs = 0;
      this.emitStatus();
      this.armTimer();
      return this.status();
    } catch (error) {
      if (error instanceof MatrixHttpError && error.status === 401) {
        this.authRequired = true;
        this.lastError = "Paper Matrix session expired";
        this.emitStatus();
        throw matrixErrorFromHttp(error);
      }
      if (error instanceof MatrixHttpError && error.status === 429) {
        this.backoffMs = Math.max(this.backoffMs, error.retryAfterMs ?? 60_000);
        this.lastError = "Paper Matrix rate-limited sync";
        this.emitStatus();
        this.armTimer();
        throw matrixErrorFromHttp(error);
      }
      this.lastError = errorMessage(error);
      this.sync = { ...this.sync, running: false, phase: "idle", currentTitle: null };
      this.backoffMs = this.backoffMs === 0 ? 60_000 : Math.min(this.backoffMs * 2, 30 * 60_000);
      this.emitStatus();
      this.armTimer();
      throw createHostError("INTERNAL_ERROR", this.lastError, { retryable: true });
    }
  }

  private emitStatus(): void {
    try {
      this.options.emit.status(this.status());
    } catch (error) {
      logger.error("Failed to publish matrix status", { error: errorMessage(error) });
    }
  }

  private armTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.stopped || !this.auth) return;
    const jitter = 0.9 + Math.random() * 0.2;
    const intervalMs = this.settings.pollIntervalMin * 60_000 * jitter;
    const delay = Math.max(5 * 60_000, this.backoffMs || intervalMs);
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      void this.syncNow("interval").catch((error: unknown) => {
        logger.warn("Scheduled Paper Matrix sync failed", { error: errorMessage(error) });
      });
    }, delay);
    this.timer.unref?.();
  }

  private async takeToken(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(
      TOKEN_BUDGET_PER_MIN,
      this.tokens + (elapsed * TOKEN_BUDGET_PER_MIN) / 60_000,
    );
    this.lastRefill = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) * 60_000) / TOKEN_BUDGET_PER_MIN;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      timer.unref?.();
    });
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

function nonNeg(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isHostError(value: unknown): value is HostError {
  return Boolean(value && typeof value === "object" && "code" in value && "message" in value);
}
