import { createHash } from "node:crypto";
import { join, relative, resolve, sep } from "node:path";

const ILLEGAL = /[\\/:*?"<>|]/g;

export function sanitizeName(name: string): string {
  const cleaned = name.replace(ILLEGAL, "_").replace(/\s+/g, " ").trim();
  const withoutDots = cleaned.replace(/[. ]+$/g, "");
  return withoutDots || "untitled";
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function paperFileName(item: {
  dedup_key: string;
  title: string;
  year: number | null;
}): string {
  const year = item.year && item.year > 0 ? String(item.year) : "undated";
  const title = sanitizeName(item.title);
  return `${year} - ${title}.md`;
}

export function folderDirName(folder: string): string {
  return sanitizeName(folder);
}

export function paperRelativePath(
  folder: string,
  item: { dedup_key: string; title: string; year: number | null },
  occupied: Set<string>,
): string {
  const dir = folderDirName(folder);
  const base = paperFileName(item);
  let relativePath = `${dir}/${base}`;
  if (occupied.has(relativePath.toLowerCase())) {
    const hashed = `${dir}/${paperFileName(item).replace(/\.md$/u, "")} ${shortHash(item.dedup_key)}.md`;
    relativePath = hashed;
  }
  occupied.add(relativePath.toLowerCase());
  return relativePath;
}

export function resolveLibraryPath(libraryRoot: string, relativePath: string): string {
  const root = resolve(libraryRoot);
  const target = resolve(root, relativePath);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === ".." || rel.split(/[\\/]/).includes("..")) {
    throw new Error("path escapes library root");
  }
  return target;
}

export function isProtectedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.split(/[\\/]/).filter(Boolean);
  const first = normalized[0];
  return (
    first === ".sync" ||
    first === "notes" ||
    first === "reviews" ||
    normalized[normalized.length - 1] === "AGENTS.md"
  );
}

export function trashStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function posixJoin(...parts: string[]): string {
  return join(...parts)
    .split(sep)
    .join("/");
}
