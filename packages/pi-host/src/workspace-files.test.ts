import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_DIRECTORY_WATCHES,
  MAX_TEXT_FILE_BYTES,
  WorkspaceFileService,
  listWorkspaceDirectory,
  normalizeWorkspaceRelativePath,
  readWorkspaceTextFile,
} from "./workspace-files.js";

// Node 24.18.0 predates the Windows fs-event fix in libuv/libuv#5152 and can abort here.
const hasBrokenWindowsFsWatch = process.platform === "win32" && process.versions.node === "24.18.0";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pideck-workspace-files-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "README.md"), "readme");
  await writeFile(join(root, "src", "index.ts"), "export {};");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("workspace relative paths", () => {
  it("normalizes portable relative paths and rejects escapes", () => {
    expect(normalizeWorkspaceRelativePath("")).toBe("");
    expect(normalizeWorkspaceRelativePath("src\\components/./Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
    expect(() => normalizeWorkspaceRelativePath("../outside")).toThrow(/cannot leave/);
    expect(() => normalizeWorkspaceRelativePath("C:\\outside")).toThrow(/relative/);
    expect(() => normalizeWorkspaceRelativePath("/outside")).toThrow(/relative/);
  });
});

describe("listWorkspaceDirectory", () => {
  it("returns a directory-first, workspace-relative listing", async () => {
    await expect(listWorkspaceDirectory(root, "")).resolves.toEqual({
      path: "",
      entries: [
        { name: "src", path: "src", kind: "dir", symlink: false },
        { name: "README.md", path: "README.md", kind: "file", symlink: false },
      ],
    });
  });

  it("does not traverse symbolic-link directories", async () => {
    try {
      await symlink(join(root, "src"), join(root, "linked-src"), "dir");
    } catch {
      return;
    }
    const listing = await listWorkspaceDirectory(root, "");
    expect(listing.entries.find((entry) => entry.name === "linked-src")).toEqual({
      name: "linked-src",
      path: "linked-src",
      kind: "file",
      symlink: true,
    });
    await expect(listWorkspaceDirectory(root, "linked-src")).rejects.toThrow(/Symbolic-link/);
  });
});

describe("WorkspaceFileService", () => {
  it("rejects more than the bounded number of watches", async () => {
    const service = new WorkspaceFileService();
    const paths = Array.from({ length: MAX_DIRECTORY_WATCHES + 1 }, (_, index) => `d${index}`);
    await expect(service.setDirectoryWatches(root, paths, () => {})).rejects.toThrow(/At most/);
    service.dispose();
  });

  it.skipIf(hasBrokenWindowsFsWatch)(
    "coalesces changes for watched expanded directories",
    async () => {
      const service = new WorkspaceFileService();
      const changed = new Promise<string[]>((resolve) => {
        void service.setDirectoryWatches(root, ["src"], resolve);
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(join(root, "src", "second.ts"), "export const second = true;");
      await expect(changed).resolves.toEqual(["src"]);
      service.dispose();
    },
  );
});

describe("readWorkspaceTextFile", () => {
  it("returns workspace-relative path and utf8 content", async () => {
    await writeFile(join(root, "notes.txt"), "# 标题\nhello");
    await expect(readWorkspaceTextFile(root, "notes.txt")).resolves.toEqual({
      path: "notes.txt",
      content: "# 标题\nhello",
      size: Buffer.byteLength("# 标题\nhello", "utf8"),
      truncated: false,
      binary: false,
    });
  });

  it("reads nested files through forward-slash separators", async () => {
    await writeFile(join(root, "src", "nested.md"), "body");
    await expect(readWorkspaceTextFile(root, "src/nested.md")).resolves.toMatchObject({
      path: "src/nested.md",
      content: "body",
      truncated: false,
      binary: false,
    });
  });

  it("rejects path escapes, directories, and missing files", async () => {
    await expect(readWorkspaceTextFile(root, "../outside.txt")).rejects.toThrow(/cannot leave/);
    await expect(readWorkspaceTextFile(root, "src")).rejects.toThrow(/not a file/);
    await expect(readWorkspaceTextFile(root, "missing.txt")).rejects.toThrow();
  });

  it("refuses symbolic-link files", async () => {
    let supported = true;
    try {
      await symlink(join(root, "README.md"), join(root, "linked.md"), "file");
    } catch {
      supported = false;
    }
    if (!supported) return;
    await expect(readWorkspaceTextFile(root, "linked.md")).rejects.toThrow(/symbolic/i);
  });

  it("flags binary files with a NUL byte and skips decoding", async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x00, 0x03, 0x04]);
    await writeFile(join(root, "archive.bin"), bytes);
    await expect(readWorkspaceTextFile(root, "archive.bin")).resolves.toEqual({
      path: "archive.bin",
      content: "",
      size: bytes.length,
      truncated: false,
      binary: true,
    });
  });

  it("caps reads at the default maximum size", async () => {
    const body = "x".repeat(MAX_TEXT_FILE_BYTES + 1);
    await writeFile(join(root, "huge.txt"), body);
    const result = await readWorkspaceTextFile(root, "huge.txt");
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(MAX_TEXT_FILE_BYTES);
    expect(result.size).toBe(MAX_TEXT_FILE_BYTES + 1);
  });

  it("truncates content beyond the byte cap", async () => {
    const body = "a".repeat(4096);
    await writeFile(join(root, "large.txt"), body);
    await expect(readWorkspaceTextFile(root, "large.txt", 1024)).resolves.toEqual({
      path: "large.txt",
      content: "a".repeat(1024),
      size: body.length,
      truncated: true,
      binary: false,
    });
  });
});
