import type { SerializableAgentContent, SerializableAgentMessage } from "@pideck/protocol";

/** File extensions surfaced as session artifacts and dock text previews. */
const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/i;
const PLAIN_TEXT_EXTENSIONS = /\.(?:txt|log|text)$/i;

/** File-name classifier shared by the dock artifacts page and preview affordances. */
export function isPreviewableFileName(path: string): boolean {
  return MARKDOWN_EXTENSIONS.test(path) || PLAIN_TEXT_EXTENSIONS.test(path);
}

/**
 * Map a tool-call path onto a workspace-relative preview path. Returns null for
 * paths outside the workspace, which the preview cannot read.
 */
export function toWorkspaceRelativePath(path: string, canonicalCwd: string): string | null {
  const trimmed = path.trim();
  if (!trimmed) return null;
  const portableCwd = canonicalCwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const portable = trimmed.replace(/\\/g, "/");
  if (!/^(?:[A-Za-z]:)?\//.test(portable)) return portable;
  const prefix = portableCwd + "/";
  if (portable.startsWith(prefix) && portable.length > prefix.length) {
    return portable.slice(prefix.length);
  }
  if (portable === portableCwd) return null;
  return null;
}

export type SessionArtifact = {
  path: string;
  name: string;
  lastWrittenAt: number;
};

type ToolCallPart = {
  type: string;
  name?: string;
  arguments?: unknown;
  startedAt?: number;
  endedAt?: number;
};

const MUTATION_TOOL_NAMES = new Set(["edit", "write", "write_file", "apply_patch"]);

function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s.-]+/g, "_");
}

function isMutationToolName(name: string): boolean {
  return MUTATION_TOOL_NAMES.has(normalizeToolName(name));
}

function parseToolArguments(value: unknown): Record<string, unknown> | null {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function toolCallPath(part: ToolCallPart): string {
  const args = parseToolArguments(part.arguments);
  if (!args) return "";
  for (const key of ["path", "filePath", "file_path"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function messageContentParts(message: SerializableAgentMessage): SerializableAgentContent[] {
  return Array.isArray(message.content) ? message.content : [];
}

/**
 * Derive the md/txt artifacts of the current session from file-mutation tool
 * calls in the transcript. Last write wins per path; newest artifact first.
 */
export function collectArtifacts(
  messages: readonly SerializableAgentMessage[],
  canonicalCwd: string,
): SessionArtifact[] {
  if (!canonicalCwd) return [];
  const byPath = new Map<string, SessionArtifact>();
  for (const message of messages) {
    for (const part of messageContentParts(message)) {
      if (part.type !== "toolCall") continue;
      const name = typeof part.name === "string" ? part.name : "";
      if (!isMutationToolName(name)) continue;
      const rawPath = toolCallPath(part as ToolCallPart);
      if (!rawPath) continue;
      const path = toWorkspaceRelativePath(rawPath, canonicalCwd);
      if (!path || !isPreviewableFileName(path)) continue;
      const startedAt = typeof part.startedAt === "number" ? part.startedAt : 0;
      const endedAt = typeof part.endedAt === "number" ? part.endedAt : startedAt;
      const previous = byPath.get(path);
      if (previous && previous.lastWrittenAt >= endedAt) continue;
      byPath.set(path, {
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        lastWrittenAt: endedAt,
      });
    }
  }
  return [...byPath.values()].sort((left, right) => right.lastWrittenAt - left.lastWrittenAt);
}
