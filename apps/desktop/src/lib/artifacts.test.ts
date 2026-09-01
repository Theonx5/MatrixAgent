import { describe, expect, it } from "vitest";
import type { SerializableAgentMessage } from "@pideck/protocol";
import { collectArtifacts, isPreviewableFileName, toWorkspaceRelativePath } from "./artifacts";

const CWD = "C:/work/project";

function toolMessage(
  name: string,
  args: unknown,
  times: { startedAt?: number; endedAt?: number } = {},
): SerializableAgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "t1",
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
        startedAt: times.startedAt ?? 100,
        endedAt: times.endedAt ?? 200,
      },
    ],
  };
}

describe("toWorkspaceRelativePath", () => {
  it("converts absolute paths inside the workspace and rejects others", () => {
    expect(toWorkspaceRelativePath("C:/work/project/notes.md", CWD)).toBe("notes.md");
    expect(toWorkspaceRelativePath("C:\\work\\project\\docs\\a.md", CWD)).toBe("docs/a.md");
    expect(toWorkspaceRelativePath("C:/work/project", CWD)).toBeNull();
    expect(toWorkspaceRelativePath("C:/elsewhere/x.md", CWD)).toBeNull();
    expect(toWorkspaceRelativePath("", CWD)).toBeNull();
  });

  it("passes relative paths through", () => {
    expect(toWorkspaceRelativePath("docs/a.md", CWD)).toBe("docs/a.md");
  });
});

describe("isPreviewableFileName", () => {
  it("accepts markdown and plain text extensions only", () => {
    expect(isPreviewableFileName("README.md")).toBe(true);
    expect(isPreviewableFileName("notes.txt")).toBe(true);
    expect(isPreviewableFileName("slide.md")).toBe(true);
    expect(isPreviewableFileName("image.png")).toBe(false);
    expect(isPreviewableFileName("code.ts")).toBe(false);
  });
});

describe("collectArtifacts", () => {
  it("collects write and edit targets, newest first", () => {
    const messages = [
      toolMessage("write", { path: "C:/work/project/draft.md" }, { startedAt: 10, endedAt: 20 }),
      toolMessage("edit", { path: "C:/work/project/notes.txt" }, { startedAt: 30, endedAt: 40 }),
    ];
    expect(collectArtifacts(messages, CWD)).toEqual([
      { path: "notes.txt", name: "notes.txt", lastWrittenAt: 40 },
      { path: "draft.md", name: "draft.md", lastWrittenAt: 20 },
    ]);
  });

  it("keeps the last write per path", () => {
    const messages = [
      toolMessage("write", { path: "draft.md" }, { startedAt: 10, endedAt: 20 }),
      toolMessage("write", { path: "draft.md" }, { startedAt: 50, endedAt: 60 }),
    ];
    expect(collectArtifacts(messages, CWD)).toEqual([
      { path: "draft.md", name: "draft.md", lastWrittenAt: 60 },
    ]);
  });

  it("ignores non-mutation tools, non-previewable files, and external paths", () => {
    const messages = [
      toolMessage("read", { path: "C:/work/project/README.md" }),
      toolMessage("write", { path: "C:/work/project/script.py" }),
      toolMessage("write", { path: "C:/elsewhere/notes.md" }),
      toolMessage("bash", { command: "echo hi" }),
      toolMessage("write", { command: "no path" }),
    ];
    expect(collectArtifacts(messages, CWD)).toEqual([]);
  });

  it("parses stringified and object arguments", () => {
    const objectMessage: SerializableAgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t2", name: "write_file", arguments: { path: "a.md" } }],
    };
    expect(collectArtifacts([objectMessage], CWD)).toEqual([
      { path: "a.md", name: "a.md", lastWrittenAt: 0 },
    ]);
  });

  it("skips malformed arguments without throwing", () => {
    const broken: SerializableAgentMessage = {
      role: "assistant",
      content: [{ type: "toolCall", id: "t3", name: "write", arguments: "{not json" }],
    };
    expect(collectArtifacts([broken], CWD)).toEqual([]);
  });

  it("returns empty for a missing workspace", () => {
    expect(collectArtifacts([toolMessage("write", { path: "a.md" })], "")).toEqual([]);
  });
});
