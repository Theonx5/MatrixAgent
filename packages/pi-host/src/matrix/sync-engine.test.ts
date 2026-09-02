import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import { MatrixApiClient, type MatrixFetch, type PaperMatrixManifest } from "./client.js";
import { seedLibrary } from "./library.js";
import { MatrixSyncEngine } from "./sync-engine.js";

function arrayBufferOf(bytes: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function jsonResult(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Awaited<ReturnType<MatrixFetch>> {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => text,
    arrayBuffer: async () => arrayBufferOf(Buffer.from(text)),
  };
}

async function zipOf(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const [name, content] of Object.entries(files)) {
    zip.addBuffer(Buffer.isBuffer(content) ? content : Buffer.from(content), name);
  }
  zip.end();
  return done;
}

function manifest(items: PaperMatrixManifest["items"]): PaperMatrixManifest {
  return {
    generated_at: "2026-09-01T00:00:00+08:00",
    total: items.length,
    page: 1,
    collections: [
      {
        id: "c1",
        name: "LLM",
        is_default: true,
        is_shared_inbox: false,
        sort_order: 0,
      },
    ],
    items,
  };
}

function fakeServer(options: {
  pages?: PaperMatrixManifest[];
  markdown?: Record<string, string | { status: number }>;
  images?: Record<string, Buffer | { status: number }>;
  unauthorizedOnce?: boolean;
  rateLimitOnce?: boolean;
}): { fetch: MatrixFetch; calls: string[] } {
  const calls: string[] = [];
  let unauthorized = options.unauthorizedOnce === true;
  let rateLimited = options.rateLimitOnce === true;
  const pages = options.pages ?? [];
  const fetchImpl: MatrixFetch = async (input, init) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname === "/api/auth/login") {
      return jsonResult({
        access_token: "tok",
        token_type: "bearer",
        user: {
          id: "u1",
          username: "alice",
          display_name: "Alice",
          role: "paid",
          effective_role: "paid",
        },
      });
    }
    if (unauthorized) {
      unauthorized = false;
      return jsonResult({ detail: "expired" }, 401);
    }
    if (rateLimited) {
      rateLimited = false;
      return jsonResult({ detail: "slow down" }, 429, { "retry-after": "1" });
    }
    if (url.pathname === "/api/collections/sync/manifest") {
      const page = Number(url.searchParams.get("page") ?? "1");
      return jsonResult(
        pages[page - 1] ?? { generated_at: "", total: 0, page, collections: [], items: [] },
      );
    }
    const mdMatch = url.pathname.match(/\/api\/collections\/assets\/([^/]+)\/md$/u);
    if (mdMatch) {
      const assetId = decodeURIComponent(mdMatch[1] ?? "");
      const entry = options.markdown?.[assetId];
      if (entry && typeof entry === "object" && "status" in entry) {
        return jsonResult({ detail: "missing" }, entry.status);
      }
      if (typeof entry === "string") return jsonResult({ content: entry });
      return jsonResult({ detail: "missing" }, 404);
    }
    const imageMatch = url.pathname.match(/\/api\/collections\/sync\/images\/([^/]+)$/u);
    if (imageMatch) {
      const assetId = decodeURIComponent(imageMatch[1] ?? "");
      const entry = options.images?.[assetId];
      if (entry && typeof entry === "object" && "status" in entry) {
        return jsonResult({ detail: "missing" }, entry.status);
      }
      if (Buffer.isBuffer(entry)) {
        return {
          status: 200,
          headers: { get: () => "application/zip" },
          json: async () => null,
          text: async () => "",
          arrayBuffer: async () => arrayBufferOf(entry),
        };
      }
      return jsonResult({ detail: "missing" }, 404);
    }
    return jsonResult({ detail: "not found" }, 404);
  };
  return { fetch: fetchImpl, calls };
}

const paperA = {
  dedup_key: "doi:10.1/a",
  title: "Paper A",
  authors: ["A"],
  year: 2024,
  venue: "Nature",
  journal_rank: null,
  doi: "10.1/a",
  cited_by_count: 1,
  tags: [],
  folders: ["LLM"],
  collected_at: "2026-01-01T00:00:00Z",
  asset: { asset_id: "asset-a", md_updated_at: "2026-01-02T00:00:00Z", md_size: 4 },
};

const paperB = {
  ...paperA,
  dedup_key: "doi:10.1/b",
  title: "Paper B",
  doi: "10.1/b",
  asset: { asset_id: "asset-b", md_updated_at: "2026-01-03T00:00:00Z", md_size: 4 },
};

describe("MatrixSyncEngine", () => {
  it("writes new papers, skips unchanged bodies, and pages the manifest", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const { fetch, calls } = fakeServer({
      pages: [
        { ...manifest([paperA]), total: 2 },
        { ...manifest([paperB]), total: 2 },
      ],
      markdown: {
        "asset-a": "# A\n",
        "asset-b": "# B\n",
      },
    });
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
    });
    const engine = new MatrixSyncEngine(client);
    const first = await engine.run({
      libraryRoot: library,
      withAbstract: true,
      hooks: { onProgress: () => undefined },
    });
    expect(first.downloaded).toBe(2);
    expect(readFileSync(join(library, "LLM", "2024 - Paper A.md"), "utf8")).toContain("# A");
    expect(readFileSync(join(library, "LLM", "2024 - Paper B.md"), "utf8")).toContain("# B");
    expect(readFileSync(join(library, ".sync", "catalog.md"), "utf8")).toContain("Paper A");
    expect(calls.some((call) => call.includes("page=2"))).toBe(true);
    expect(calls.some((call) => call.includes("with_images=1"))).toBe(true);

    const second = await engine.run({
      libraryRoot: library,
      withAbstract: true,
      hooks: { onProgress: () => undefined },
    });
    expect(second.downloaded).toBe(0);
    expect(calls.filter((call) => call.includes("/md")).length).toBe(2);
  });

  it("does not overwrite locally edited papers and keeps the previous md_updated_at", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const { fetch } = fakeServer({
      pages: [manifest([paperA])],
      markdown: { "asset-a": "# A\n" },
    });
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
    });
    const engine = new MatrixSyncEngine(client);
    await engine.run({
      libraryRoot: library,
      withAbstract: true,
      hooks: { onProgress: () => undefined },
    });
    const paperPath = join(library, "LLM", "2024 - Paper A.md");
    writeFileSync(paperPath, readFileSync(paperPath, "utf8").replace("# A", "# edited"));

    const { fetch: fetch2 } = fakeServer({
      pages: [
        manifest([
          {
            ...paperA,
            asset: { asset_id: "asset-a", md_updated_at: "2026-02-01T00:00:00Z", md_size: 8 },
          },
        ]),
      ],
      markdown: { "asset-a": "# server\n" },
    });
    const engine2 = new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch: fetch2,
        getToken: () => "tok",
      }),
    );
    const result = await engine2.run({
      libraryRoot: library,
      withAbstract: true,
      hooks: { onProgress: () => undefined },
    });
    expect(result.conflicts).toBe(1);
    expect(readFileSync(paperPath, "utf8")).toContain("# edited");
    expect(readFileSync(join(library, "reviews", "conflicts", "doi_10.1_a.md"), "utf8")).toContain(
      "# server",
    );
    const state = JSON.parse(readFileSync(join(library, ".sync", "state.json"), "utf8")) as {
      items: Record<string, { mdUpdatedAt: string }>;
    };
    expect(state.items["doi:10.1/a"]?.mdUpdatedAt).toBe("2026-01-02T00:00:00Z");
  });

  it("skips a 404 markdown body without updating md_updated_at", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const { fetch } = fakeServer({
      pages: [manifest([paperA])],
      markdown: { "asset-a": { status: 404 } },
    });
    const engine = new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch,
        getToken: () => "tok",
      }),
    );
    const result = await engine.run({
      libraryRoot: library,
      withAbstract: true,
      hooks: { onProgress: () => undefined },
    });
    expect(result.skipped).toBe(1);
    const state = JSON.parse(readFileSync(join(library, ".sync", "state.json"), "utf8")) as {
      items: Record<string, { mdUpdatedAt: string | null }>;
    };
    expect(state.items["doi:10.1/a"]?.mdUpdatedAt).toBeNull();
  });

  it("moves deleted papers into trash", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const first = fakeServer({
      pages: [manifest([paperA])],
      markdown: { "asset-a": "# A\n" },
    });
    await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch: first.fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });

    const second = fakeServer({ pages: [manifest([])] });
    await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch: second.fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });

    const state = JSON.parse(readFileSync(join(library, ".sync", "state.json"), "utf8")) as {
      items: Record<string, unknown>;
    };
    expect(state.items["doi:10.1/a"]).toBeUndefined();
  });

  it("unzips paper images next to markdown and skips a 404 zip", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const zip = await zipOf({ "img_0.jpg": "figure-bytes" });
    const paperWithImages = {
      ...paperA,
      asset: {
        asset_id: "asset-a",
        md_updated_at: "2026-01-02T00:00:00Z",
        md_size: 4,
        images: { files: [{ name: "img_0.jpg", size: 12 }], total_size: 12 },
      },
    };
    const paperWithoutImages = {
      ...paperB,
      asset: {
        asset_id: "asset-b",
        md_updated_at: "2026-01-03T00:00:00Z",
        md_size: 4,
        images: { files: [{ name: "missing.png", size: 1 }], total_size: 1 },
      },
    };
    const { fetch, calls } = fakeServer({
      pages: [manifest([paperWithImages, paperWithoutImages])],
      markdown: { "asset-a": "![fig](images/img_0.jpg)\n", "asset-b": "# B\n" },
      images: { "asset-a": zip, "asset-b": { status: 404 } },
    });
    const result = await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });
    expect(result.downloaded).toBe(2);
    expect(readFileSync(join(library, "LLM", "images", "img_0.jpg"), "utf8")).toBe("figure-bytes");
    expect(calls.filter((call) => call.includes("/sync/images/")).length).toBe(2);

    const second = fakeServer({
      pages: [manifest([paperWithImages, paperWithoutImages])],
      markdown: { "asset-a": "changed\n", "asset-b": "changed\n" },
      images: { "asset-a": zip },
    });
    await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch: second.fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });
    expect(second.calls.filter((call) => call.includes("/sync/images/")).length).toBe(0);
  });

  it("backfills images for already synced papers when local files are missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const first = fakeServer({
      pages: [manifest([paperA])],
      markdown: { "asset-a": "# A\n" },
    });
    await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch: first.fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });
    expect(first.calls.filter((call) => call.includes("/sync/images/")).length).toBe(0);

    const zip = await zipOf({ "img_0.jpg": "figure-bytes" });
    const paperWithImages = {
      ...paperA,
      asset: {
        asset_id: "asset-a",
        md_updated_at: "2026-01-02T00:00:00Z",
        md_size: 4,
        images: { files: [{ name: "img_0.jpg", size: 12 }], total_size: 12 },
      },
    };
    const second = fakeServer({
      pages: [manifest([paperWithImages])],
      markdown: { "asset-a": "changed\n" },
      images: { "asset-a": zip },
    });
    const result = await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch: second.fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });
    expect(second.calls.filter((call) => call.includes("/md")).length).toBe(0);
    expect(second.calls.filter((call) => call.includes("/sync/images/")).length).toBe(1);
    expect(result.downloaded).toBe(1);
    expect(readFileSync(join(library, "LLM", "images", "img_0.jpg"), "utf8")).toBe("figure-bytes");
  });

  it("does not advance md_updated_at when image zip download fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const paperWithImages = {
      ...paperA,
      asset: {
        asset_id: "asset-a",
        md_updated_at: "2026-01-02T00:00:00Z",
        md_size: 4,
        images: { files: [{ name: "img_0.jpg", size: 12 }], total_size: 12 },
      },
    };
    const { fetch } = fakeServer({
      pages: [manifest([paperWithImages])],
      markdown: { "asset-a": "# A\n" },
      images: { "asset-a": { status: 500 } },
    });
    const result = await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });
    expect(result.skipped).toBe(1);
    expect(result.downloaded).toBe(0);
    const state = JSON.parse(readFileSync(join(library, ".sync", "state.json"), "utf8")) as {
      items: Record<string, { mdUpdatedAt: string | null }>;
    };
    expect(state.items["doi:10.1/a"]).toBeUndefined();
  });

  it("keeps markdown when an image zip cannot be extracted", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-sync-"));
    const library = join(root, "library");
    await seedLibrary(library);
    const paperWithImages = {
      ...paperA,
      asset: {
        asset_id: "asset-a",
        md_updated_at: "2026-01-02T00:00:00Z",
        md_size: 4,
        images: { files: [{ name: "img_0.jpg", size: 12 }], total_size: 12 },
      },
    };
    const { fetch } = fakeServer({
      pages: [manifest([paperWithImages])],
      markdown: { "asset-a": "![fig](images/img_0.jpg)\n" },
      images: { "asset-a": Buffer.from("PK\x03\x04not-a-real-zip") },
    });
    const result = await new MatrixSyncEngine(
      new MatrixApiClient({
        baseUrl: "https://papermatrix.online",
        fetch,
        getToken: () => "tok",
      }),
    ).run({ libraryRoot: library, withAbstract: true, hooks: { onProgress: () => undefined } });
    expect(result.downloaded).toBe(1);
    expect(readFileSync(join(library, "LLM", "2024 - Paper A.md"), "utf8")).toContain("img_0.jpg");
    const state = JSON.parse(readFileSync(join(library, ".sync", "state.json"), "utf8")) as {
      items: Record<string, { imagesFetched?: boolean }>;
    };
    expect(state.items["doi:10.1/a"]?.imagesFetched).not.toBe(true);
  });
});

describe("MatrixApiClient", () => {
  it("retries once after 401 when onUnauthorized succeeds", async () => {
    const { fetch, calls } = fakeServer({
      pages: [manifest([paperA])],
      markdown: { "asset-a": "# A\n" },
      unauthorizedOnce: true,
    });
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
      onUnauthorized: async () => true,
    });
    const result = await client.fetchManifest({ withAbstract: false });
    expect(result.items).toHaveLength(1);
    expect(calls.filter((call) => call.includes("/manifest")).length).toBe(2);
  });

  it("surfaces 429 retry-after", async () => {
    const { fetch } = fakeServer({
      pages: [manifest([])],
      rateLimitOnce: true,
    });
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
    });
    await expect(client.fetchManifest({ withAbstract: false })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 1000,
    });
  });

  it("retries login as form data after JSON 422", async () => {
    const calls: string[] = [];
    const fetch: MatrixFetch = async (_input, init) => {
      const type = init?.headers?.["Content-Type"] ?? "";
      calls.push(type);
      if (type.includes("application/json")) {
        return jsonResult({ detail: "Use form login" }, 422);
      }
      return jsonResult({
        token: "tok",
        user: { id: "u1", username: "alice", display_name: null },
      });
    };
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => null,
    });
    const result = await client.login("alice", "secret");
    expect(result.access_token).toBe("tok");
    expect(calls).toEqual(["application/json", "application/x-www-form-urlencoded"]);
  });

  it("reads camelCase asset ids from the manifest", async () => {
    const fetch: MatrixFetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.includes("/manifest")) {
        return jsonResult({
          generated_at: "t",
          total: 1,
          papers: [
            {
              dedupKey: "doi:10.1/z",
              title: "Z",
              folders: ["LLM"],
              assetId: "asset-z",
              md_updated_at: "2026-01-01T00:00:00Z",
            },
          ],
        });
      }
      return jsonResult({ markdown: "# Z\n" });
    };
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
    });
    const result = await client.fetchManifest({ withAbstract: false });
    expect(result.items[0]?.asset?.asset_id).toBe("asset-z");
    await expect(client.fetchMarkdown("asset-z")).resolves.toBe("# Z\n");
  });

  it("flattens papers nested inside collections", async () => {
    const fetch: MatrixFetch = async () =>
      jsonResult({
        data: {
          collections: [
            {
              id: "c1",
              name: "LLM",
              items: [{ title: "Nested", doi: "10.1/n", markdown: "# Nested\n" }],
            },
          ],
        },
      });
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
    });
    const result = await client.fetchManifest({ withAbstract: false });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Nested");
    expect(result.items[0]?.folders).toEqual(["LLM"]);
    expect(result.items[0]?.inlineMd).toBe("# Nested\n");
  });

  it("fills empty manifest items from collection item endpoints", async () => {
    const fetch: MatrixFetch = async (input) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/manifest")) {
        return jsonResult({
          collections: [{ id: "c1", name: "LLM" }],
          items: [],
        });
      }
      if (url.pathname.endsWith("/items")) {
        return jsonResult({
          items: [{ id: "p1", title: "From folder", year: 2024 }],
        });
      }
      return jsonResult({ detail: "missing" }, 404);
    };
    const client = new MatrixApiClient({
      baseUrl: "https://papermatrix.online",
      fetch,
      getToken: () => "tok",
    });
    const result = await client.fetchManifest({ withAbstract: false });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.dedup_key).toBe("id:p1");
    expect(result.items[0]?.folders).toEqual(["LLM"]);
  });
});
