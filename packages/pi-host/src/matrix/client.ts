import { createHostError, type HostError } from "@pideck/protocol";

export const DEFAULT_MATRIX_BASE_URL = "https://papermatrix.online";

export type PaperMatrixUser = {
  id: string;
  username: string;
  display_name: string;
  role: string;
  effective_role: string;
};

export type PaperMatrixLoginResult = {
  access_token: string;
  token_type: string;
  user: PaperMatrixUser;
};

type PaperMatrixCollection = {
  id: string;
  name: string;
  is_default: boolean;
  is_shared_inbox: boolean;
  sort_order: number;
};

type PaperMatrixImageFile = {
  name: string;
  size: number;
};

type PaperMatrixImages = {
  files: PaperMatrixImageFile[];
  total_size: number;
};

type PaperMatrixAsset = {
  asset_id: string;
  md_updated_at: string;
  md_size: number;
  images?: PaperMatrixImages;
};

export type PaperMatrixItem = {
  dedup_key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  journal_rank: { sci?: number; if?: number } | null;
  doi: string | null;
  cited_by_count: number | null;
  tags: string[];
  folders: string[];
  collected_at: string;
  abstract?: string;
  bibtex?: string;
  inlineMd?: string;
  asset: PaperMatrixAsset | null;
};

export type PaperMatrixManifest = {
  generated_at: string;
  total: number;
  page: number;
  collections: PaperMatrixCollection[];
  items: PaperMatrixItem[];
};

export type MatrixFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export class MatrixHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "MatrixHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function matrixErrorFromHttp(error: MatrixHttpError): HostError {
  if (error.status === 401) {
    return createHostError("AUTH_REQUIRED", error.message);
  }
  if (error.status === 0) {
    return createHostError("INTERNAL_ERROR", error.message, {
      retryable: true,
      details: { status: 0 },
    });
  }
  if (error.status === 429) {
    return createHostError("INVALID_REQUEST", error.message, {
      retryable: true,
      details: { status: 429, retryAfterMs: error.retryAfterMs },
    });
  }
  return createHostError("INTERNAL_ERROR", error.message, {
    retryable: error.status >= 500,
    details: { status: error.status },
  });
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

export class MatrixApiClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      fetch: MatrixFetch;
      getToken: () => string | null;
      onUnauthorized?: () => Promise<boolean>;
      takeToken?: () => Promise<void>;
    },
  ) {}

  async login(
    username: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<PaperMatrixLoginResult> {
    try {
      return await this.loginOnce(username, password, "json", signal);
    } catch (error) {
      if (
        error instanceof MatrixHttpError &&
        (error.status === 400 || error.status === 415 || error.status === 422)
      ) {
        return this.loginOnce(username, password, "form", signal);
      }
      throw error;
    }
  }

  private async loginOnce(
    username: string,
    password: string,
    mode: "json" | "form",
    signal?: AbortSignal,
  ): Promise<PaperMatrixLoginResult> {
    const payload = await this.requestJson(
      "/api/auth/login",
      mode === "json"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
            signal,
          }
        : {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ username, password }).toString(),
            signal,
          },
      { auth: false, retryOn401: false },
    );
    const parsed = parseLoginResult(payload);
    if (!parsed) throw new MatrixHttpError(500, "Login response was missing a token");
    return parsed;
  }

  async me(signal?: AbortSignal): Promise<PaperMatrixUser> {
    const payload = await this.requestJson("/api/auth/me", { signal }, { auth: true });
    if (
      !payload ||
      typeof payload !== "object" ||
      typeof (payload as { id?: unknown }).id !== "string"
    ) {
      throw new MatrixHttpError(500, "Current-user response was invalid");
    }
    return payload as PaperMatrixUser;
  }

  async fetchManifest(options: {
    withAbstract: boolean;
    signal?: AbortSignal;
  }): Promise<PaperMatrixManifest> {
    let manifest: PaperMatrixManifest;
    try {
      const first = await this.fetchManifestPage(1, 1000, options.withAbstract, options.signal);
      const items = [...first.items];
      const collections = first.collections;
      let page = first.page || 1;
      const total = typeof first.total === "number" ? first.total : items.length;
      while (items.length < total) {
        page += 1;
        const next = await this.fetchManifestPage(page, 1000, options.withAbstract, options.signal);
        if (next.items.length === 0) break;
        items.push(...next.items);
        if (next.items.length < 1000) break;
      }
      manifest = {
        generated_at: first.generated_at,
        total: items.length,
        page: 1,
        collections,
        items,
      };
    } catch (error) {
      if (!(error instanceof MatrixHttpError) || error.status !== 404) throw error;
      manifest = {
        generated_at: new Date().toISOString(),
        total: 0,
        page: 1,
        collections: await this.fetchCollectionList(options.signal),
        items: [],
      };
    }
    if (manifest.items.length === 0 && manifest.collections.length > 0) {
      const extras = await this.fetchItemsForCollections(manifest.collections, options.signal);
      manifest = { ...manifest, items: extras, total: extras.length };
    }
    return manifest;
  }

  async fetchMarkdown(assetId: string, signal?: AbortSignal): Promise<string> {
    const payload = await this.requestJson(
      `/api/collections/assets/${encodeURIComponent(assetId)}/md`,
      { signal },
      { auth: true },
    );
    const content = extractMarkdown(payload);
    if (content == null) throw new MatrixHttpError(500, "Markdown response was invalid");
    return content;
  }

  async fetchImagesZip(assetId: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.request(
      `/api/collections/sync/images/${encodeURIComponent(assetId)}`,
      { signal },
      { auth: true },
    );
    return decodeImagesZip(Buffer.from(await response.arrayBuffer()));
  }

  private async fetchManifestPage(
    page: number,
    pageSize: number,
    withAbstract: boolean,
    signal?: AbortSignal,
  ): Promise<PaperMatrixManifest> {
    const params = new URLSearchParams({
      with_abstract: withAbstract ? "1" : "0",
      with_bibtex: "1",
      with_images: "1",
      page: String(page),
      page_size: String(pageSize),
    });
    const payload = await this.requestJson(
      `/api/collections/sync/manifest?${params.toString()}`,
      { signal },
      { auth: true },
    );
    return parseManifestPayload(payload, page);
  }

  private async fetchCollectionList(signal?: AbortSignal): Promise<PaperMatrixCollection[]> {
    try {
      const payload = await this.requestJson("/api/collections", { signal }, { auth: true });
      const raw = unwrapRecord(payload);
      const list = asArray(raw.collections) ?? asArray(raw.items) ?? asArray(payload) ?? [];
      return list.map(normalizeCollection).filter((collection) => collection.name);
    } catch (error) {
      if (error instanceof MatrixHttpError && error.status === 404) return [];
      throw error;
    }
  }

  private async fetchItemsForCollections(
    collections: PaperMatrixCollection[],
    signal?: AbortSignal,
  ): Promise<PaperMatrixItem[]> {
    const items: PaperMatrixItem[] = [];
    for (const collection of collections) {
      if (!collection.id) continue;
      const paths = [
        `/api/collections/${encodeURIComponent(collection.id)}/items`,
        `/api/collections/${encodeURIComponent(collection.id)}/papers`,
        `/api/collections/${encodeURIComponent(collection.id)}`,
      ];
      for (const path of paths) {
        try {
          const payload = await this.requestJson(path, { signal }, { auth: true });
          const list = extractRawItems(unwrapRecord(payload), payload);
          if (list.length === 0) continue;
          for (const raw of list) {
            const item = normalizeItem(raw, collection.name);
            if (item.dedup_key) items.push(item);
          }
          break;
        } catch (error) {
          if (error instanceof MatrixHttpError && (error.status === 404 || error.status === 405)) {
            continue;
          }
          throw error;
        }
      }
    }
    return items;
  }

  private async request(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {},
    options: { auth: boolean; retryOn401?: boolean },
  ): Promise<Awaited<ReturnType<MatrixFetch>>> {
    await this.options.takeToken?.();
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (options.auth) {
      const token = this.options.getToken();
      if (!token) throw new MatrixHttpError(401, "Not signed in to Paper Matrix");
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await this.options.fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (response.status === 401 && options.auth && options.retryOn401 !== false) {
      const refreshed = await this.options.onUnauthorized?.();
      if (refreshed) {
        return this.request(path, init, { ...options, retryOn401: false });
      }
    }
    if (response.status === 429) {
      throw new MatrixHttpError(
        429,
        "Paper Matrix rate-limited the request",
        parseRetryAfter(response.headers.get("Retry-After")) ?? 60_000,
      );
    }
    if (response.status >= 400) {
      const body = await response.text().catch(() => "");
      throw new MatrixHttpError(response.status, httpMessage(response.status, body));
    }
    return response;
  }

  private async requestJson(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: AbortSignal;
    } = {},
    options: { auth: boolean; retryOn401?: boolean },
  ): Promise<unknown> {
    const response = await this.request(path, init, options);
    if (response.status === 204) return null;
    return response.json();
  }
}

function httpMessage(status: number, body: string): string {
  const detail = extractDetail(body);
  if (detail) return detail;
  if (status === 401) return "Paper Matrix credentials were rejected";
  if (status === 404) return "Paper Matrix resource was not found";
  if (status === 422) return "Paper Matrix rejected the request";
  const trimmed = body.trim().slice(0, 200);
  return trimmed || `Paper Matrix request failed (${status})`;
}

function extractDetail(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown; error?: unknown };
    if (typeof parsed.detail === "string" && parsed.detail.trim()) return parsed.detail;
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
    if (Array.isArray(parsed.detail) && parsed.detail[0]) {
      const first = parsed.detail[0] as { msg?: unknown };
      if (typeof first.msg === "string") return first.msg;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

function parseLoginResult(payload: unknown): PaperMatrixLoginResult | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  const token =
    pickString(nested.access_token) ??
    pickString(nested.token) ??
    pickString(nested.accessToken) ??
    pickString(record.access_token) ??
    pickString(record.token);
  if (!token) return null;
  return {
    access_token: token,
    token_type: pickString(nested.token_type) ?? "bearer",
    user: (nested.user ?? record.user ?? {}) as PaperMatrixUser,
  };
}

function extractMarkdown(payload: unknown): string | null {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const nested =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : record;
  for (const key of ["content", "markdown", "md", "text", "body"]) {
    const value = pickString(nested[key]) ?? pickString(record[key]);
    if (value != null) return value;
  }
  return null;
}

function unwrapRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const record = payload as Record<string, unknown>;
  for (const key of ["data", "result", "payload", "manifest"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return nested as Record<string, unknown>;
    }
  }
  return record;
}

function extractRawItems(raw: Record<string, unknown>, payload: unknown): unknown[] {
  const top =
    asArray(raw.items) ??
    asArray(raw.papers) ??
    asArray(raw.entries) ??
    asArray(raw.documents) ??
    (Array.isArray(payload) ? payload : null) ??
    [];
  const nested: unknown[] = [];
  const collections = asArray(raw.collections) ?? asArray(raw.folders) ?? [];
  for (const collection of collections) {
    if (!collection || typeof collection !== "object") continue;
    const record = collection as Record<string, unknown>;
    const kids = asArray(record.items) ?? asArray(record.papers) ?? asArray(record.entries);
    if (!kids) continue;
    const folderName = pickString(record.name);
    for (const kid of kids) {
      if (kid && typeof kid === "object") {
        nested.push({ ...(kid as Record<string, unknown>), __folder: folderName });
      } else {
        nested.push(kid);
      }
    }
  }
  return [...top, ...nested];
}

function parseManifestPayload(payload: unknown, page: number): PaperMatrixManifest {
  if (!payload || typeof payload !== "object") {
    throw new MatrixHttpError(500, "Manifest response was invalid");
  }
  const raw = unwrapRecord(payload);
  const collections = (asArray(raw.collections) ?? asArray(raw.folders) ?? []).map(
    normalizeCollection,
  );
  const items = extractRawItems(raw, payload).map((item) => normalizeItem(item));
  return {
    generated_at: pickString(raw.generated_at) ?? pickString(raw.generatedAt) ?? "",
    total: typeof raw.total === "number" ? raw.total : items.length,
    page: typeof raw.page === "number" ? raw.page : page,
    collections,
    items,
  };
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asStringList(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry === "object") {
        const record = entry as Record<string, unknown>;
        return pickString(record.name) ?? pickString(record.title) ?? "";
      }
      return String(entry);
    })
    .filter((entry) => entry.length > 0);
}

function pickString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeCollection(raw: unknown): PaperMatrixCollection {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    id: pickString(record.id) ?? "",
    name: pickString(record.name) ?? "library",
    is_default: record.is_default === true,
    is_shared_inbox: record.is_shared_inbox === true,
    sort_order: typeof record.sort_order === "number" ? record.sort_order : 0,
  };
}

function normalizeItem(raw: unknown, folderName?: string | null): PaperMatrixItem {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const doi = pickString(record.doi);
  const title = pickString(record.title) ?? pickString(record.name) ?? "Untitled";
  const id = pickString(record.id) ?? pickString(record.paper_id) ?? pickString(record.paperId);
  const dedup =
    pickString(record.dedup_key) ??
    pickString(record.dedupKey) ??
    pickString(record.key) ??
    (doi ? `doi:${doi}` : null) ??
    (id ? `id:${id}` : null) ??
    `title:${title}`;
  const nestedAsset =
    record.asset && typeof record.asset === "object"
      ? (record.asset as Record<string, unknown>)
      : null;
  const assetId =
    pickString(nestedAsset?.asset_id) ??
    pickString(nestedAsset?.assetId) ??
    pickString(nestedAsset?.id) ??
    pickString(record.asset_id) ??
    pickString(record.assetId);
  const folders = asStringList(
    record.folders ??
      record.collections ??
      record.collection_names ??
      record.__folder ??
      folderName,
  );
  const inlineMd = extractMarkdown(record);
  const bibtex =
    pickString(record.bibtex) ?? pickString(record.bibTeX) ?? pickString(record.BibTeX);
  const images = normalizeImages(nestedAsset?.images ?? record.images);
  return {
    dedup_key: dedup,
    title,
    authors: asStringList(record.authors ?? record.author),
    year: typeof record.year === "number" ? record.year : null,
    venue: record.venue == null ? null : String(record.venue),
    journal_rank: (record.journal_rank as PaperMatrixItem["journal_rank"]) ?? null,
    doi,
    cited_by_count: typeof record.cited_by_count === "number" ? record.cited_by_count : null,
    tags: asStringList(record.tags),
    folders,
    collected_at: pickString(record.collected_at) ?? pickString(record.collectedAt) ?? "",
    ...(typeof record.abstract === "string" ? { abstract: record.abstract } : {}),
    ...(bibtex ? { bibtex } : {}),
    ...(inlineMd ? { inlineMd } : {}),
    asset: assetId
      ? {
          asset_id: assetId,
          md_updated_at:
            pickString(nestedAsset?.md_updated_at) ??
            pickString(nestedAsset?.updated_at) ??
            pickString(record.md_updated_at) ??
            "",
          md_size:
            typeof nestedAsset?.md_size === "number"
              ? nestedAsset.md_size
              : typeof record.md_size === "number"
                ? record.md_size
                : 0,
          ...(images ? { images } : {}),
        }
      : null,
  };
}

function normalizeImageFile(entry: unknown): PaperMatrixImageFile | null {
  if (typeof entry === "string" && entry.trim()) return { name: entry.trim(), size: 0 };
  if (!entry || typeof entry !== "object") return null;
  const item = entry as Record<string, unknown>;
  const name = pickString(item.name) ?? pickString(item.filename) ?? pickString(item.path);
  if (!name) return null;
  return { name, size: typeof item.size === "number" ? item.size : 0 };
}

function normalizeImages(raw: unknown): PaperMatrixImages | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) {
    const files = raw
      .map(normalizeImageFile)
      .filter((entry): entry is PaperMatrixImageFile => entry !== null);
    return { files, total_size: files.reduce((sum, file) => sum + file.size, 0) };
  }
  if (typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const files = (
    asArray(record.files) ??
    asArray(record.image_files) ??
    asArray(record.items) ??
    []
  )
    .map(normalizeImageFile)
    .filter((entry): entry is PaperMatrixImageFile => entry !== null);
  const flagged = record.has_images === true || record.hasImages === true;
  const total_size =
    typeof record.total_size === "number"
      ? record.total_size
      : typeof record.totalSize === "number"
        ? record.totalSize
        : files.reduce((sum, file) => sum + file.size, 0);
  return {
    files,
    total_size: total_size > 0 ? total_size : flagged && files.length === 0 ? 1 : total_size,
  };
}

function isZipBuffer(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function decodeImagesZip(bytes: Buffer): Buffer {
  if (isZipBuffer(bytes)) return bytes;
  const text = bytes.toString("utf8").trim();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown> | unknown[];
      const record = Array.isArray(parsed) ? {} : parsed;
      const encoded =
        (typeof record.content === "string" && record.content) ||
        (typeof record.data === "string" && record.data) ||
        (typeof record.zip === "string" && record.zip) ||
        (typeof record.file === "string" && record.file) ||
        null;
      if (encoded) {
        const payload = encoded.includes("base64,")
          ? encoded.slice(encoded.indexOf("base64,") + "base64,".length)
          : encoded;
        const decoded = Buffer.from(payload, "base64");
        if (isZipBuffer(decoded)) return decoded;
      }
    } catch {
      /* not JSON */
    }
  }
  throw new MatrixHttpError(500, "Images response was not a zip archive");
}
