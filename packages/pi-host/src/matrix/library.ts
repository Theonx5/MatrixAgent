import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromBufferPromise } from "yauzl";
import { randomUUID } from "node:crypto";
import type { PaperMatrixItem, PaperMatrixManifest } from "./client.js";
import {
  LIBRARY_AGENTS_MD,
  MATRIX_PROMPTS,
  MATRIX_SKILLS,
  MATRIX_SYSTEM_MD,
} from "./seed-content.js";
import {
  folderDirName,
  isProtectedRelativePath,
  paperRelativePath,
  posixJoin,
  resolveLibraryPath,
  trashStamp,
} from "./paths.js";

const DIR_MODE = 0o700;
const MAX_PAPER_IMAGE_FILES = 2000;
const MAX_PAPER_IMAGE_BYTES = 512 * 1024 * 1024;
const ZIP32_SIZE_SENTINEL = 0xfffffff0;
const PAPER_IMAGE_EXTENSIONS = new Set([
  ".apng",
  ".avif",
  ".bmp",
  ".gif",
  ".jfif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

export type LocalPaperState = {
  mdUpdatedAt: string | null;
  assetId: string | null;
  paths: string[];
  bodyHash: string | null;
  imagesFetched?: boolean;
  meta: {
    title: string;
    authors: string[];
    year: number | null;
    venue: string | null;
    doi: string | null;
    tags: string[];
    folders: string[];
    cited_by_count: number | null;
    bibtex: string | null;
  };
};

export type SyncStateFile = {
  generatedAt: string;
  collections: PaperMatrixManifest["collections"];
  items: Record<string, LocalPaperState>;
};

type LibraryIndexItem = {
  dedup_key: string;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string | null;
  tags: string[];
  folders: string[];
  paths: string[];
  has_md: boolean;
  md_size: number;
};

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null | undefined)?.code;
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") await chmod(path, DIR_MODE).catch(() => undefined);
}

async function writeAtomicFile(path: string, content: string | Uint8Array): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, content);
  try {
    await rename(tempPath, path);
  } catch (error) {
    if (errnoCode(error) === "EEXIST" || errnoCode(error) === "EPERM") {
      await unlink(path).catch(() => undefined);
      await rename(tempPath, path);
      return;
    }
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      await writeAtomicFile(path, content);
      return;
    }
    throw error;
  }
}

export function resolveBundledSkillsRoot(fromFile = import.meta.url): string | undefined {
  const here = dirname(fileURLToPath(fromFile));
  return [join(here, "../resources/skills"), join(here, "../../resources/skills")].find((path) =>
    existsSync(path),
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function copyDirIfMissing(src: string, dest: string): Promise<void> {
  if (await pathExists(dest)) return;
  await cp(src, dest, { recursive: true });
}

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const text = String(value);
  if (text === "" || /[:#{}[\],&*!|>'"%@\`]|--|\n|\r/.test(text) || text !== text.trim()) {
    return JSON.stringify(text);
  }
  return text;
}

export function renderFrontMatter(item: PaperMatrixItem, syncedAt: string): string {
  const lines = [
    `title: ${yamlScalar(item.title)}`,
    "authors:",
    ...(item.authors.length ? item.authors.map((author) => `  - ${yamlScalar(author)}`) : ["  []"]),
    `year: ${item.year ?? "null"}`,
    `venue: ${yamlScalar(item.venue)}`,
    `doi: ${yamlScalar(item.doi)}`,
    `dedup_key: ${yamlScalar(item.dedup_key)}`,
    item.journal_rank
      ? `journal_rank: { sci: ${item.journal_rank.sci ?? "null"}, if: ${item.journal_rank.if ?? "null"} }`
      : "journal_rank: null",
    `cited_by_count: ${item.cited_by_count ?? "null"}`,
    "tags:",
    ...(item.tags.length ? item.tags.map((tag) => `  - ${yamlScalar(tag)}`) : ["  []"]),
    "folders:",
    ...(item.folders.length ? item.folders.map((folder) => `  - ${yamlScalar(folder)}`) : ["  []"]),
    `collected_at: ${yamlScalar(item.collected_at)}`,
    `synced_at: ${yamlScalar(syncedAt)}`,
    `asset_id: ${yamlScalar(item.asset?.asset_id ?? null)}`,
    `md_updated_at: ${yamlScalar(item.asset?.md_updated_at ?? null)}`,
  ];
  if (item.abstract) lines.push(`abstract: ${yamlScalar(item.abstract)}`);
  if (item.bibtex) lines.push(`bibtex: ${yamlScalar(item.bibtex)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

export function splitFrontMatter(raw: string): { matter: string | null; body: string } {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { matter: null, body: raw };
  }
  const rest = raw.slice(raw.startsWith("---\r\n") ? 5 : 4);
  const match = rest.match(/\r?\n---\r?\n/);
  if (!match || match.index === undefined) return { matter: null, body: raw };
  const body = rest.slice(match.index + match[0].length);
  return { matter: rest.slice(0, match.index), body };
}

export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

export function renderPaperFile(item: PaperMatrixItem, body: string, syncedAt: string): string {
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  return `${renderFrontMatter(item, syncedAt)}\n${normalized}`;
}

export async function seedLibrary(libraryRoot: string): Promise<void> {
  await ensureDir(libraryRoot);
  await ensureDir(join(libraryRoot, "notes"));
  await ensureDir(join(libraryRoot, "reviews"));
  await ensureDir(join(libraryRoot, ".sync"));
  await writeIfMissing(join(libraryRoot, "AGENTS.md"), LIBRARY_AGENTS_MD);
}

export async function seedUserResources(agentDir: string): Promise<void> {
  const skillsRoot = join(agentDir, "skills");
  const promptsRoot = join(agentDir, "prompts");
  await ensureDir(skillsRoot);
  await ensureDir(promptsRoot);
  await writeIfMissing(join(agentDir, "SYSTEM.md"), MATRIX_SYSTEM_MD);
  const bundledSkills = resolveBundledSkillsRoot();
  if (bundledSkills) {
    for (const entry of await readdir(bundledSkills, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      await copyDirIfMissing(join(bundledSkills, entry.name), join(skillsRoot, entry.name));
    }
  }
  for (const skill of MATRIX_SKILLS) {
    await writeIfMissing(join(skillsRoot, skill.name, "SKILL.md"), skill.markdown);
  }
  for (const prompt of MATRIX_PROMPTS) {
    await writeIfMissing(join(promptsRoot, prompt.fileName), prompt.markdown);
  }
}

export async function loadSyncState(libraryRoot: string): Promise<SyncStateFile> {
  try {
    const raw = await readFile(join(libraryRoot, ".sync", "state.json"), "utf8");
    const parsed = JSON.parse(raw) as SyncStateFile;
    if (!parsed || typeof parsed !== "object" || typeof parsed.items !== "object") {
      return { generatedAt: "", collections: [], items: {} };
    }
    return {
      generatedAt: parsed.generatedAt ?? "",
      collections: Array.isArray(parsed.collections) ? parsed.collections : [],
      items: parsed.items ?? {},
    };
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { generatedAt: "", collections: [], items: {} };
    throw error;
  }
}

export async function saveSyncState(libraryRoot: string, state: SyncStateFile): Promise<void> {
  await writeAtomicFile(
    join(libraryRoot, ".sync", "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export function allocatePaths(item: PaperMatrixItem, occupied: Set<string>): string[] {
  const folders = item.folders.length > 0 ? item.folders : ["library"];
  return folders.map((folder) => paperRelativePath(folder, item, occupied));
}

export async function readBodyHash(
  libraryRoot: string,
  relativePath: string,
): Promise<string | null> {
  try {
    const raw = await readFile(resolveLibraryPath(libraryRoot, relativePath), "utf8");
    return hashBody(splitFrontMatter(raw).body);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

export async function writePaper(
  libraryRoot: string,
  relativePath: string,
  item: PaperMatrixItem,
  body: string,
  syncedAt: string,
): Promise<void> {
  await writeAtomicFile(
    resolveLibraryPath(libraryRoot, relativePath),
    renderPaperFile(item, body, syncedAt),
  );
}

export async function writePaperImages(
  libraryRoot: string,
  paperRelativePath: string,
  zipBytes: Buffer,
): Promise<void> {
  const paperPath = resolveLibraryPath(libraryRoot, paperRelativePath);
  await extractImagesZip(zipBytes, join(dirname(paperPath), "images"));
}

export function imageNamesFromMarkdown(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/images\/([^)\s"'<>\\]+)/gi)) {
    const name = basename(match[1] ?? "");
    if (name && name !== "." && name !== "..") names.add(name);
  }
  return [...names];
}

export async function listedLocalImageNames(
  libraryRoot: string,
  paperRelativePath: string,
): Promise<string[]> {
  try {
    const raw = await readFile(resolveLibraryPath(libraryRoot, paperRelativePath), "utf8");
    return imageNamesFromMarkdown(splitFrontMatter(raw).body);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

export async function paperImagesNeedSync(
  libraryRoot: string,
  paperRelativePath: string,
  files: Array<{ name: string }>,
): Promise<boolean> {
  if (files.length === 0) return false;
  const paperPath = resolveLibraryPath(libraryRoot, paperRelativePath);
  const dir = join(dirname(paperPath), "images");
  for (const file of files) {
    const name = basename(file.name);
    if (!name || name === "." || name === "..") continue;
    try {
      await stat(join(dir, name));
    } catch (error) {
      if (errnoCode(error) === "ENOENT") return true;
      throw error;
    }
  }
  return false;
}

function isPaperImageFileName(name: string): boolean {
  if (!name || name.startsWith(".") || name.toLowerCase() === "thumbs.db") return false;
  return PAPER_IMAGE_EXTENSIONS.has(extname(name).toLowerCase());
}

async function extractImagesZip(zipBytes: Buffer, destDir: string): Promise<void> {
  const zip = await fromBufferPromise(zipBytes, {
    autoClose: false,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  try {
    let files = 0;
    let bytes = 0;
    await ensureDir(destDir);
    for await (const entry of zip.eachEntry()) {
      const rawName = entry.fileName.replace(/\\/g, "/");
      if (rawName.endsWith("/")) continue;
      if (rawName.split("/").some((part) => part === "__MACOSX" || part.startsWith("."))) continue;
      const name = basename(rawName);
      if (!name || name === "." || name === ".." || name.includes("\0")) {
        throw new Error(`Unsafe image zip entry: ${entry.fileName}`);
      }
      if (!isPaperImageFileName(name)) continue;
      if (entry.isEncrypted()) throw new Error("Encrypted image zip is not supported");
      if (files >= MAX_PAPER_IMAGE_FILES || bytes >= MAX_PAPER_IMAGE_BYTES) continue;
      const claimed = Number(entry.uncompressedSize) || 0;
      if (claimed > 0 && claimed < ZIP32_SIZE_SENTINEL && bytes + claimed > MAX_PAPER_IMAGE_BYTES) {
        continue;
      }
      const target = resolve(destDir, name);
      const rel = relative(destDir, target);
      if (!rel || rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) {
        throw new Error(`Image zip entry escapes destination: ${entry.fileName}`);
      }
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let written = 0;
      let overflow = false;
      for await (const chunk of stream) {
        const piece = Buffer.from(chunk);
        if (overflow) continue;
        if (bytes + written + piece.length > MAX_PAPER_IMAGE_BYTES) {
          overflow = true;
          continue;
        }
        chunks.push(piece);
        written += piece.length;
      }
      if (overflow || written === 0) continue;
      await writeAtomicFile(target, Buffer.concat(chunks));
      files += 1;
      bytes += written;
    }
  } finally {
    zip.close();
  }
}

export async function rewriteFrontMatter(
  libraryRoot: string,
  relativePath: string,
  item: PaperMatrixItem,
  syncedAt: string,
): Promise<void> {
  const fullPath = resolveLibraryPath(libraryRoot, relativePath);
  const raw = await readFile(fullPath, "utf8");
  const { body } = splitFrontMatter(raw);
  await writeAtomicFile(fullPath, renderPaperFile(item, body, syncedAt));
}

export async function moveToTrash(
  libraryRoot: string,
  relativePath: string,
  when: Date,
): Promise<void> {
  if (isProtectedRelativePath(relativePath)) return;
  const source = resolveLibraryPath(libraryRoot, relativePath);
  const target = resolveLibraryPath(
    libraryRoot,
    posixJoin(".sync", "trash", trashStamp(when), relativePath),
  );
  try {
    await ensureDir(dirname(target));
    await rename(source, target);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
}

export async function writeIndex(
  libraryRoot: string,
  manifest: PaperMatrixManifest,
  states: Record<string, LocalPaperState>,
): Promise<void> {
  const items: LibraryIndexItem[] = manifest.items.map((item) => ({
    dedup_key: item.dedup_key,
    title: item.title,
    authors: item.authors,
    year: item.year,
    venue: item.venue,
    doi: item.doi,
    tags: item.tags,
    folders: item.folders,
    paths: states[item.dedup_key]?.paths ?? [],
    has_md: Boolean(item.asset),
    md_size: item.asset?.md_size ?? 0,
  }));
  await writeAtomicFile(
    join(libraryRoot, ".sync", "index.json"),
    `${JSON.stringify({ generated_at: manifest.generated_at, items }, null, 2)}\n`,
  );
  const byFolder = new Map<string, LibraryIndexItem[]>();
  for (const item of items) {
    const folders = item.folders.length > 0 ? item.folders : ["library"];
    for (const folder of folders) {
      const list = byFolder.get(folder) ?? [];
      list.push(item);
      byFolder.set(folder, list);
    }
  }
  const lines = [`# Library catalog`, "", `Generated at ${manifest.generated_at}`, ""];
  for (const [folder, folderItems] of [...byFolder.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    lines.push(`## ${folder}`, "");
    for (const item of folderItems.sort(
      (a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title),
    )) {
      const year = item.year ?? "n.d.";
      const doi = item.doi ? ` — ${item.doi}` : "";
      const path = item.paths[0] ? ` (\`${item.paths[0]}\`)` : "";
      lines.push(`- ${year} **${item.title}**${doi}${path}`);
    }
    lines.push("");
  }
  await writeAtomicFile(join(libraryRoot, ".sync", "catalog.md"), `${lines.join("\n")}\n`);
}

export function metaChanged(previous: LocalPaperState | undefined, item: PaperMatrixItem): boolean {
  if (!previous) return true;
  return (
    previous.meta.title !== item.title ||
    previous.meta.year !== item.year ||
    previous.meta.venue !== item.venue ||
    previous.meta.doi !== item.doi ||
    previous.meta.cited_by_count !== item.cited_by_count ||
    previous.meta.authors.join("\0") !== item.authors.join("\0") ||
    previous.meta.tags.join("\0") !== item.tags.join("\0") ||
    previous.meta.folders.join("\0") !== item.folders.join("\0") ||
    (previous.meta.bibtex ?? null) !== (item.bibtex ?? null)
  );
}

export function itemToLocalState(
  item: PaperMatrixItem,
  paths: string[],
  bodyHash: string | null,
  imagesFetched?: boolean,
): LocalPaperState {
  return {
    mdUpdatedAt: item.asset?.md_updated_at ?? null,
    assetId: item.asset?.asset_id ?? null,
    paths,
    bodyHash,
    ...(imagesFetched !== undefined ? { imagesFetched } : {}),
    meta: {
      title: item.title,
      authors: item.authors,
      year: item.year,
      venue: item.venue,
      doi: item.doi,
      tags: item.tags,
      folders: item.folders,
      cited_by_count: item.cited_by_count,
      bibtex: item.bibtex ?? null,
    },
  };
}

export async function writeCollectionBibFiles(
  libraryRoot: string,
  items: PaperMatrixItem[],
): Promise<void> {
  const byFolder = new Map<string, string[]>();
  for (const item of items) {
    const entry = item.bibtex?.trim();
    if (!entry) continue;
    const folders = item.folders.length > 0 ? item.folders : ["library"];
    for (const folder of folders) {
      const list = byFolder.get(folder) ?? [];
      list.push(entry.endsWith("\n") ? entry.trimEnd() : entry);
      byFolder.set(folder, list);
    }
  }
  for (const [folder, entries] of byFolder) {
    const relativePath = `${folderDirName(folder)}.bib`;
    const content = `${[...new Set(entries)].join("\n\n")}\n`;
    await writeAtomicFile(resolveLibraryPath(libraryRoot, relativePath), content);
  }
}
