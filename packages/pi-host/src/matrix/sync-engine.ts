import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { MatrixProgressPayload, MatrixSyncProgress } from "@pideck/protocol";
import { idleMatrixSyncProgress } from "@pideck/protocol";
import { logger } from "../logger.js";
import {
  MatrixHttpError,
  type MatrixApiClient,
  type PaperMatrixItem,
  type PaperMatrixManifest,
} from "./client.js";
import {
  allocatePaths,
  itemToLocalState,
  loadSyncState,
  metaChanged,
  moveToTrash,
  paperBackoffDue,
  paperFileExists,
  readBodyHash,
  rewriteFrontMatter,
  saveSyncState,
  writeCollectionBibFiles,
  writeIndex,
  imageNamesFromMarkdown,
  listedLocalImageNames,
  paperImagesNeedSync,
  writePaper,
  writePaperImages,
  type LocalPaperState,
  type SyncStateFile,
} from "./library.js";
import { folderDirName, resolveLibraryPath, sanitizeName } from "./paths.js";

export type SyncRunReason = "manual" | "interval" | "startup";

export type SyncEngineHooks = {
  onProgress: (progress: MatrixSyncProgress, payload: MatrixProgressPayload) => void;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

function placeholderBody(item: PaperMatrixItem): string {
  return `_Full text has not been converted yet._\n\n${item.abstract ? item.abstract.trim() + "\n" : ""}`;
}

function shouldFetchImages(item: PaperMatrixItem, extraNames: string[] = []): boolean {
  if (!item.asset) return false;
  const files = item.asset.images?.files ?? [];
  const total = item.asset.images?.total_size ?? 0;
  return files.length > 0 || total > 0 || extraNames.length > 0;
}

function listedImageFiles(
  item: PaperMatrixItem,
  extraNames: string[] = [],
): Array<{ name: string }> {
  const names = new Set<string>();
  for (const file of item.asset?.images?.files ?? []) names.add(file.name);
  for (const name of extraNames) names.add(name);
  return [...names].map((name) => ({ name }));
}

async function extractDownloadedImages(
  libraryRoot: string,
  paths: string[],
  zip: Buffer | null,
  dedupKey: string,
): Promise<boolean> {
  if (!zip) return true;
  try {
    for (const relativePath of paths) {
      await writePaperImages(libraryRoot, relativePath, zip);
    }
    return true;
  } catch (error) {
    logger.warn("Paper image extract failed", {
      dedupKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export class MatrixSyncEngine {
  constructor(private readonly client: MatrixApiClient) {}

  async run(options: {
    libraryRoot: string;
    withAbstract: boolean;
    signal?: AbortSignal;
    pollIntervalMin?: number;
    now?: () => Date;
    hooks: SyncEngineHooks;
  }): Promise<MatrixSyncProgress> {
    const now = options.now ?? (() => new Date());
    const pollIntervalMin = options.pollIntervalMin ?? 180;
    const runId = randomUUID();
    const progress: MatrixSyncProgress = {
      ...idleMatrixSyncProgress(),
      running: true,
      runId,
      phase: "manifest",
    };
    const emit = (phase: MatrixProgressPayload["phase"], currentTitle: string | null = null) => {
      const title = typeof currentTitle === "string" ? currentTitle : null;
      progress.phase = phase;
      progress.currentTitle = title;
      options.hooks.onProgress(progress, {
        runId,
        phase,
        done: progress.done,
        total: progress.total,
        currentTitle: title,
      });
    };

    emit("manifest");
    const manifest = await this.client.fetchManifest({
      withAbstract: options.withAbstract,
      signal: options.signal,
    });
    progress.collections = manifest.collections.length;
    progress.items = manifest.items.length;
    progress.total = manifest.items.length;
    emit("diff");
    // Duplicate dedup_keys (a server bug, or two untitleable papers falling
    // back to `title:` keys) must not compete: the later one would steal the
    // path plan and clobber the earlier one's sync state.
    const seenKeys = new Set<string>();
    const manifestItems: PaperMatrixItem[] = [];
    for (const item of manifest.items) {
      if (!item.dedup_key) continue;
      if (seenKeys.has(item.dedup_key)) {
        logger.warn("Skipping duplicate manifest item", { dedupKey: item.dedup_key });
        continue;
      }
      seenKeys.add(item.dedup_key);
      manifestItems.push(item);
    }
    const dedupedManifest: PaperMatrixManifest = { ...manifest, items: manifestItems };
    progress.collections = manifest.collections.length;
    progress.items = manifestItems.length;
    for (const collection of manifest.collections) {
      if (!collection.name) continue;
      await mkdir(resolveLibraryPath(options.libraryRoot, folderDirName(collection.name)), {
        recursive: true,
      });
    }

    const previous = await loadSyncState(options.libraryRoot);
    // Papers that vanished from the manifest are carried through intermediate
    // state saves so a mid-run failure never orphans their files; the final
    // save (after the trash pass) drops them.
    const carried: Record<string, LocalPaperState> = {};
    const manifestKeys = new Set(manifestItems.map((item) => item.dedup_key));
    for (const [dedupKey, state] of Object.entries(previous.items)) {
      if (!manifestKeys.has(dedupKey)) carried[dedupKey] = state;
    }
    const persistState = async (): Promise<void> => {
      // Per-paper checkpoint (§6.3): every settled item advances the diff
      // baseline immediately, so one permanently failing paper can never
      // re-trigger a full-library refetch, and a crash resumes instead of
      // restarting.
      await saveSyncState(options.libraryRoot, {
        generatedAt: manifest.generated_at,
        collections: manifest.collections,
        items: { ...carried, ...nextItems },
      });
    };
    const occupied = new Set<string>();
    const nextItems: Record<string, LocalPaperState> = {};
    const toFetch: PaperMatrixItem[] = [];
    const toMeta: PaperMatrixItem[] = [];
    const toImages: PaperMatrixItem[] = [];
    const pathPlan = new Map<string, string[]>();

    for (const item of manifestItems) {
      if (!item.dedup_key) continue;
      const paths = allocatePaths(item, occupied);
      pathPlan.set(item.dedup_key, paths);
      const old = previous.items[item.dedup_key];
      const mdUpdatedAt = item.asset?.md_updated_at ?? null;
      if (!old || old.mdUpdatedAt !== mdUpdatedAt) {
        if (old && !paperBackoffDue(old, now(), pollIntervalMin)) {
          // Repeatedly failing paper in its backoff window: settle it without
          // a single request this round; the failure bookkeeping stays so the
          // schedule keeps advancing.
          nextItems[item.dedup_key] = { ...old, paths };
          continue;
        }
        toFetch.push(item);
      } else if (old.paths[0] && !(await paperFileExists(options.libraryRoot, old.paths[0]))) {
        // State says synced but the body file vanished (manual deletion,
        // interrupted sync). Refetch instead of silently staying missing —
        // this branch is what runs when metadata is unchanged.
        toFetch.push(item);
      } else {
        if (metaChanged(old, item)) toMeta.push(item);
        else nextItems[item.dedup_key] = { ...old, paths };
        if (old.imagesFetched !== true) toImages.push(item);
      }
    }

    // Meta-only refresh runs BEFORE the fetch pool: a paper entry whose file
    // vanished from disk (state said synced) is discovered here and must land
    // in the same fetch pool — pushing to toFetch after it already drained
    // would silently leave the paper missing until md_updated_at changes.
    const remetaFetch: PaperMatrixItem[] = [];
    for (const item of toMeta) {
      const paths = pathPlan.get(item.dedup_key) ?? [];
      const old = previous.items[item.dedup_key];
      let missing = false;
      for (const relativePath of paths) {
        try {
          const syncedAt = new Date().toISOString();
          await rewriteFrontMatter(options.libraryRoot, relativePath, item, syncedAt);
        } catch (error) {
          if (errnoCode(error) === "ENOENT") {
            missing = true;
            continue;
          }
          throw error;
        }
      }
      if (missing) {
        remetaFetch.push(item);
        continue;
      }
      nextItems[item.dedup_key] = {
        ...itemToLocalState(item, paths, old?.bodyHash ?? null),
        ...(old?.imagesFetched !== undefined ? { imagesFetched: old.imagesFetched } : {}),
      };
    }
    // Persist meta-only refreshes as a checkpoint; a crash here just redoes
    // local front-matter rewrites next round (no network cost).
    await persistState();

    // §6.4 target state: total counts only papers that actually need
    // downloading this round; unchanged/backoff-settled items never enter the
    // counter, so a no-change round is 0/0 and numbers never jump around.
    progress.total = toFetch.length + remetaFetch.length;
    emit("fetch");
    await mapPool([...toFetch, ...remetaFetch], 2, async (item) => {
      options.signal?.throwIfAborted();
      const paths = pathPlan.get(item.dedup_key) ?? [];
      const old = previous.items[item.dedup_key];
      // §6.3: a skipped paper keeps its previous baseline (or a null one when
      // brand new) — never the server's md_updated_at — so the next round
      // naturally retries exactly this paper, plus failure bookkeeping so
      // repeat offenders back off instead of looping.
      const settlePaperFailure = async (): Promise<void> => {
        nextItems[item.dedup_key] = {
          ...(old ? { ...old, paths } : itemToLocalState(item, paths, null)),
          mdUpdatedAt: null,
          bodyHash: null,
          failedSyncs: (old?.failedSyncs ?? 0) + 1,
          lastFailedAt: now().toISOString(),
        };
        await persistState();
      };
      let body: string | null = null;
      const locallyEdited = await this.hasLocalEdits(options.libraryRoot, old);
      if (locallyEdited) {
        progress.conflicts += 1;
        logger.warn("Skipping overwrite of locally edited paper", { dedupKey: item.dedup_key });
        if (item.asset) {
          try {
            const incoming = await this.fetchMarkdownWithRetry(item.asset.asset_id, options.signal);
            await writePaper(
              options.libraryRoot,
              `reviews/conflicts/${sanitizeName(item.dedup_key)}.md`,
              item,
              incoming,
              new Date().toISOString(),
            );
          } catch (error) {
            if (!(error instanceof MatrixHttpError && error.status === 404)) throw error;
          }
          const conflictImages = await this.syncPaperImages({
            libraryRoot: options.libraryRoot,
            item,
            paths,
            signal: options.signal,
            required: false,
          });
          await extractDownloadedImages(
            options.libraryRoot,
            paths,
            conflictImages.zip,
            item.dedup_key,
          );
        }
        nextItems[item.dedup_key] = old ? { ...old, paths } : itemToLocalState(item, paths, null);
        progress.done += 1;
        emit("fetch", item.title);
        return;
      }
      if (item.inlineMd) {
        body = item.inlineMd;
      } else if (item.asset) {
        try {
          body = await this.fetchMarkdownWithRetry(item.asset.asset_id, options.signal);
        } catch (error) {
          if (error instanceof MatrixHttpError && error.status === 404) {
            // Server says the Markdown does not exist (yet): write the
            // placeholder and record the attempt so consecutive misses back
            // off instead of hammering one request per round forever.
            progress.skipped += 1;
            body = placeholderBody(item);
            const syncedAt = new Date().toISOString();
            for (const relativePath of paths) {
              await writePaper(options.libraryRoot, relativePath, item, body, syncedAt);
            }
            nextItems[item.dedup_key] = {
              ...itemToLocalState({ ...item, asset: null }, paths, null),
              failedSyncs: (old?.failedSyncs ?? 0) + 1,
              lastFailedAt: now().toISOString(),
            };
            progress.done += 1;
            emit("fetch", item.title);
            await persistState();
            return;
          }
          // Transient/other failure after retries: skip this paper and keep
          // the run alive — never abort the round (and the baseline) because
          // one paper is broken.
          logger.warn("Skipping paper after markdown fetch failures", {
            dedupKey: item.dedup_key,
            error: error instanceof Error ? error.message : String(error),
          });
          progress.skipped += 1;
          progress.done += 1;
          emit("fetch", item.title);
          await settlePaperFailure();
          return;
        }
      } else {
        body = placeholderBody(item);
      }
      const extraNames = imageNamesFromMarkdown(body ?? "");
      const neededImages = shouldFetchImages(item, extraNames);
      const images = await this.syncPaperImages({
        libraryRoot: options.libraryRoot,
        item,
        paths,
        extraNames,
        signal: options.signal,
        required: true,
      });
      if (!images.ok) {
        progress.skipped += 1;
        progress.done += 1;
        emit("fetch", item.title);
        await settlePaperFailure();
        return;
      }
      const syncedAt = new Date().toISOString();
      for (const relativePath of paths) {
        await writePaper(options.libraryRoot, relativePath, item, body, syncedAt);
      }
      const extracted = await extractDownloadedImages(
        options.libraryRoot,
        paths,
        images.zip,
        item.dedup_key,
      );
      const hash = await readBodyHash(options.libraryRoot, paths[0] ?? "");
      nextItems[item.dedup_key] = itemToLocalState(
        item,
        paths,
        hash,
        neededImages ? extracted : undefined,
      );
      progress.downloaded += 1;
      progress.done += 1;
      emit("fetch", item.title);
      await persistState();
    });

    await mapPool(toImages, 2, async (item) => {
      options.signal?.throwIfAborted();
      const paths = pathPlan.get(item.dedup_key) ?? [];
      const current = nextItems[item.dedup_key];
      if (!current) return;
      const extraNames = paths[0] ? await listedLocalImageNames(options.libraryRoot, paths[0]) : [];
      const files = listedImageFiles(item, extraNames);
      if (!paths[0] || !(await paperImagesNeedSync(options.libraryRoot, paths[0], files))) {
        nextItems[item.dedup_key] = { ...current, imagesFetched: true };
        return;
      }
      const images = await this.syncPaperImages({
        libraryRoot: options.libraryRoot,
        item,
        paths,
        extraNames,
        signal: options.signal,
        required: false,
      });
      const extracted = await extractDownloadedImages(
        options.libraryRoot,
        paths,
        images.zip,
        item.dedup_key,
      );
      if (images.zip && extracted) progress.downloaded += 1;
      if (images.ok && extracted) nextItems[item.dedup_key] = { ...current, imagesFetched: true };
      emit("fetch", item.title);
    });

    const trashAt = new Date();
    for (const [dedupKey, old] of Object.entries(previous.items)) {
      if (nextItems[dedupKey]) continue;
      for (const relativePath of old.paths) {
        await moveToTrash(options.libraryRoot, relativePath, trashAt);
      }
    }

    emit("index");
    const nextState: SyncStateFile = {
      generatedAt: manifest.generated_at,
      collections: manifest.collections,
      items: nextItems,
    };
    await writeIndex(options.libraryRoot, dedupedManifest, nextItems);
    await writeCollectionBibFiles(options.libraryRoot, manifestItems);
    await saveSyncState(options.libraryRoot, nextState);
    progress.running = false;
    progress.phase = "idle";
    progress.currentTitle = null;
    progress.done = progress.total;
    return progress;
  }

  private async hasLocalEdits(
    libraryRoot: string,
    old: LocalPaperState | undefined,
  ): Promise<boolean> {
    const existingPath = old?.paths[0];
    if (!old?.bodyHash || !existingPath) return false;
    const current = await readBodyHash(libraryRoot, existingPath);
    return current !== null && current !== old.bodyHash;
  }

  private async fetchMarkdownWithRetry(assetId: string, signal?: AbortSignal): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.client.fetchMarkdown(assetId, signal);
      } catch (error) {
        lastError = error;
        if (error instanceof MatrixHttpError && error.status === 404) throw error;
        if (attempt === 2) break;
        await sleep(2000, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Markdown download failed");
  }

  private async fetchImagesWithRetry(assetId: string, signal?: AbortSignal): Promise<Buffer> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.client.fetchImagesZip(assetId, signal);
      } catch (error) {
        lastError = error;
        if (error instanceof MatrixHttpError && error.status === 404) throw error;
        if (attempt === 2) break;
        await sleep(2000, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Images download failed");
  }

  private async syncPaperImages(args: {
    libraryRoot: string;
    item: PaperMatrixItem;
    paths: string[];
    extraNames?: string[];
    signal?: AbortSignal;
    required: boolean;
  }): Promise<{ ok: boolean; zip: Buffer | null }> {
    if (!shouldFetchImages(args.item, args.extraNames) || !args.item.asset) {
      return { ok: true, zip: null };
    }
    try {
      const zip = await this.fetchImagesWithRetry(args.item.asset.asset_id, args.signal);
      // 200 with an empty body or a valid empty archive: the server has no
      // images for this asset — a normal result, not a failure.
      if (zip.length === 0) return { ok: true, zip: null };
      return { ok: true, zip };
    } catch (error) {
      if (error instanceof MatrixHttpError && error.status === 404) return { ok: true, zip: null };
      if (!args.required) {
        logger.warn("Skipping paper images after local edit", {
          dedupKey: args.item.dedup_key,
          error: error instanceof Error ? error.message : String(error),
        });
        return { ok: true, zip: null };
      }
      logger.warn("Paper image sync failed; leaving previous state", {
        dedupKey: args.item.dedup_key,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, zip: null };
    }
  }
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null | undefined)?.code;
}
