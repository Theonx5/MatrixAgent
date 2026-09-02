import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  folderDirName,
  isProtectedRelativePath,
  paperFileName,
  paperRelativePath,
  resolveLibraryPath,
  sanitizeName,
  shortHash,
} from "./paths.js";

describe("matrix paths", () => {
  it("strips illegal filename characters", () => {
    expect(sanitizeName("Nature/Science: Q")).toBe("Nature_Science_ Q");
    expect(folderDirName("我的收藏")).toBe("我的收藏");
  });

  it("builds a year-title paper name", () => {
    expect(
      paperFileName({
        dedup_key: "doi:10.1/x",
        title: "Attention Is All You Need",
        year: 2017,
      }),
    ).toBe("2017 - Attention Is All You Need.md");
  });

  it("adds a short hash when two papers collide", () => {
    const occupied = new Set<string>();
    const first = paperRelativePath(
      "LLM",
      {
        dedup_key: "doi:1",
        title: "Same",
        year: 2024,
      },
      occupied,
    );
    const second = paperRelativePath(
      "LLM",
      {
        dedup_key: "doi:2",
        title: "Same",
        year: 2024,
      },
      occupied,
    );
    expect(first).toBe("LLM/2024 - Same.md");
    expect(second).toContain(shortHash("doi:2"));
    expect(second).not.toBe(first);
  });

  it("rejects paths that escape the library root", () => {
    const root = join("/tmp", "library");
    expect(() => resolveLibraryPath(root, "../secret")).toThrow(/escapes/);
    expect(isProtectedRelativePath(".sync/state.json")).toBe(true);
    expect(isProtectedRelativePath("notes/idea.md")).toBe(true);
    expect(isProtectedRelativePath("LLM/paper.md")).toBe(false);
  });
});
