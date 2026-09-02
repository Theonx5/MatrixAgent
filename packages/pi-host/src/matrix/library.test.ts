import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipFile } from "yazl";
import { describe, expect, it } from "vitest";
import {
  hashBody,
  renderFrontMatter,
  renderPaperFile,
  seedLibrary,
  seedUserResources,
  splitFrontMatter,
  writeCollectionBibFiles,
  writePaper,
  writePaperImages,
} from "./library.js";
import type { PaperMatrixItem } from "./client.js";

const item: PaperMatrixItem = {
  dedup_key: "doi:10.1/x",
  title: "Attention: a paper",
  authors: ["Vaswani, A."],
  year: 2017,
  venue: "NeurIPS",
  journal_rank: { sci: 1, if: 12.5 },
  doi: "10.1/x",
  cited_by_count: 10,
  tags: ["transformer"],
  folders: ["LLM"],
  collected_at: "2026-01-01T00:00:00Z",
  bibtex: "@article{vaswani2017, title={Attention}}",
  asset: { asset_id: "asset-1", md_updated_at: "2026-01-02T00:00:00Z", md_size: 12 },
};

describe("matrix library files", () => {
  it("round-trips YAML front matter and body hashing", () => {
    const file = renderPaperFile(item, "# Hello\n", "2026-09-01T00:00:00Z");
    expect(file.startsWith("---\n")).toBe(true);
    expect(file).toContain('dedup_key: "doi:10.1/x"');
    expect(file).toContain('title: "Attention: a paper"');
    const { body } = splitFrontMatter(file);
    expect(body.trim()).toBe("# Hello");
    expect(hashBody(body)).toHaveLength(64);
    expect(renderFrontMatter(item, "t")).toContain("journal_rank: { sci: 1, if: 12.5 }");
    expect(renderFrontMatter(item, "t")).toContain("bibtex:");
  });

  it("seeds library dirs, AGENTS.md, SYSTEM.md, skills, and prompts once", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-lib-"));
    const library = join(root, "library");
    const agentDir = join(root, "agent");
    await seedLibrary(library);
    await seedUserResources(agentDir);
    expect(readFileSync(join(library, "AGENTS.md"), "utf8")).toContain("Matrix Agent");
    const systemPrompt = readFileSync(join(agentDir, "SYSTEM.md"), "utf8");
    expect(systemPrompt).toContain("academic research assistant");
    expect(systemPrompt).not.toContain("coding assistant");
    expect(readFileSync(join(agentDir, "skills", "paper-brief", "SKILL.md"), "utf8")).toContain(
      "name: paper-brief",
    );
    expect(readFileSync(join(agentDir, "prompts", "brief.md"), "utf8")).toContain("paper-brief");
    expect(readFileSync(join(agentDir, "skills", "academic-paper", "SKILL.md"), "utf8")).toContain(
      "Matrix Agent",
    );
    expect(readFileSync(join(agentDir, "skills", "nature-reader", "SKILL.md"), "utf8")).toContain(
      "local-md",
    );
    expect(readFileSync(join(agentDir, "skills", "paper-deck", "SKILL.md"), "utf8")).toContain(
      "images/",
    );
    writeFileSync(join(agentDir, "SYSTEM.md"), "custom-system-prompt\n");
    writeFileSync(join(agentDir, "skills", "academic-paper", "SKILL.md"), "keep-user-skill\n");
    await seedUserResources(agentDir);
    expect(readFileSync(join(agentDir, "SYSTEM.md"), "utf8")).toBe("custom-system-prompt\n");
    expect(readFileSync(join(agentDir, "skills", "academic-paper", "SKILL.md"), "utf8")).toBe(
      "keep-user-skill\n",
    );
    await writePaper(
      library,
      "LLM/2017 - Attention a paper.md",
      item,
      "body\n",
      "2026-09-01T00:00:00Z",
    );
    expect(readFileSync(join(library, "LLM", "2017 - Attention a paper.md"), "utf8")).toContain(
      "body",
    );
  });

  it("extracts paper image zip entries next to the markdown file", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-img-"));
    const library = join(root, "library");
    await seedLibrary(library);
    await writePaper(library, "LLM/2017 - Attention a paper.md", item, "![x](images/img_0.jpg)\n", "t");
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on("error", reject);
      zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    zip.addBuffer(Buffer.from("figure"), "img_0.jpg");
    zip.addBuffer(Buffer.from("nested"), "nested/img_1.png");
    zip.end();
    await writePaperImages(library, "LLM/2017 - Attention a paper.md", await done);
    expect(readFileSync(join(library, "LLM", "images", "img_0.jpg"), "utf8")).toBe("figure");
    expect(readFileSync(join(library, "LLM", "images", "img_1.png"), "utf8")).toBe("nested");
  });

  it("skips non-image zip entries and extracts more than 200 figures", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-img-many-"));
    const library = join(root, "library");
    await seedLibrary(library);
    await writePaper(library, "LLM/2017 - Attention a paper.md", item, "body\n", "t");
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
      zip.outputStream.on("error", reject);
      zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    });
    zip.addBuffer(Buffer.from("%PDF-1.4"), "paper.pdf");
    zip.addBuffer(Buffer.from("meta"), "__MACOSX/._img_0.jpg");
    zip.addBuffer(Buffer.from("notes"), "readme.txt");
    for (let index = 0; index < 210; index += 1) {
      zip.addBuffer(Buffer.from(`fig-${index}`), `images/img_${index}.png`);
    }
    zip.end();
    await writePaperImages(library, "LLM/2017 - Attention a paper.md", await done);
    const names = readdirSync(join(library, "LLM", "images"));
    expect(names).toHaveLength(210);
    expect(names).toContain("img_0.png");
    expect(names).toContain("img_209.png");
    expect(existsSync(join(library, "LLM", "images", "paper.pdf"))).toBe(false);
    expect(existsSync(join(library, "LLM", "images", "readme.txt"))).toBe(false);
  });

  it("aggregates BibTeX into a collection .bib file", async () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-bib-"));
    const library = join(root, "library");
    await seedLibrary(library);
    await writeCollectionBibFiles(library, [
      item,
      { ...item, dedup_key: "doi:10.1/y", folders: ["LLM", "NLP"] },
    ]);
    const bib = readFileSync(join(library, "LLM.bib"), "utf8");
    expect(bib).toContain("@article{vaswani2017");
    expect(readFileSync(join(library, "NLP.bib"), "utf8")).toContain("@article{vaswani2017");
  });
});
