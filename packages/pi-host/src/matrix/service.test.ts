import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MatrixFetch } from "./client.js";
import { MatrixService } from "./service.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function tempAgentDir(): string {
  const root = mkdtempSync(join(tmpdir(), "matrix-service-"));
  roots.push(root);
  return join(root, "agent");
}

function jsonFetch(
  routes: Array<{
    match: (url: URL, init?: Parameters<MatrixFetch>[1]) => boolean;
    status?: number;
    body: unknown;
  }>,
): MatrixFetch {
  return async (input, init) => {
    const url = new URL(input);
    for (const route of routes) {
      if (!route.match(url, init)) continue;
      const text = JSON.stringify(route.body);
      return {
        status: route.status ?? 200,
        headers: { get: () => null },
        json: async () => route.body,
        text: async () => text,
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    }
    return {
      status: 404,
      headers: { get: () => null },
      json: async () => ({ detail: "not found" }),
      text: async () => JSON.stringify({ detail: "not found" }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  };
}

const loginBody = {
  access_token: "tok",
  token_type: "bearer",
  user: {
    id: "u1",
    username: "alice",
    display_name: "Alice",
    role: "paid",
    effective_role: "paid",
  },
};

describe("MatrixService", () => {
  it("rejects a library root inside the Pi CLI directory", async () => {
    const service = new MatrixService({
      agentDir: tempAgentDir(),
      emit: { status: () => undefined, progress: () => undefined },
      fetchImpl: jsonFetch([]),
    });
    await service.start();
    await expect(
      service.patchSettings({ libraryRoot: "C:/Users/me/.pi/agent/library" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // A library root that merely shares the CLI drive root stays allowed.
    await expect(
      service.patchSettings({ libraryRoot: join(tmpdir(), "matrix-ok-library") }),
    ).resolves.toBeTruthy();
  });

  it("survives a failed post-login sync without faulting the Host", async () => {
    // Manifest requests fail after a successful login: the fire-and-forget
    // post-login sync must be captured, not surface as an unhandled rejection
    // (the Host treats those as fatal).
    const service = new MatrixService({
      agentDir: tempAgentDir(),
      emit: { status: () => undefined, progress: () => undefined },
      fetchImpl: jsonFetch([
        {
          match: (url) => url.pathname === "/api/auth/login",
          body: loginBody,
        },
        {
          match: (url) => url.pathname === "/api/collections/sync/manifest",
          status: 500,
          body: { detail: "server exploded" },
        },
      ]),
    });
    await service.start();
    const status = await service.login("alice", "pw", false);
    expect(status.loggedIn).toBe(true);
    const background = (service as unknown as { backgroundSync: Promise<void> | null })
      .backgroundSync;
    expect(background).not.toBeNull();
    await background; // must resolve, never reject
    const settled = service.status();
    expect(settled.loggedIn).toBe(true);
    expect(settled.lastError).toContain("server exploded");
    expect(settled.sync.running).toBe(false);
    await service.stop();
  });
});
