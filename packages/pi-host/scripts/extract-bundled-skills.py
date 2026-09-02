#!/usr/bin/env python3
"""Extract and adapt the three academic skill zips for Matrix Agent."""

from __future__ import annotations

import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]  # PiDeck-0.2.2
ZIPS_DIR = ROOT.parent  # E:/project/PiDeck-0.2.2
OUT = Path(__file__).resolve().parents[1] / "resources" / "skills"

ZIPS = {
    "academic-research-skills-main.zip": {
        "prefix": "academic-research-skills-main/",
        "skills": {
            "academic-paper": "academic-paper/",
            "academic-paper-reviewer": "academic-paper-reviewer/",
            "academic-pipeline": "academic-pipeline/",
            "deep-research": "deep-research/",
        },
    },
    "nature-skills-main-0901.zip": {
        "prefix": "nature-skills-main/skills/",
        "skills": {
            "nature-academic-search": "nature-academic-search/",
            "nature-citation": "nature-citation/",
            "nature-data": "nature-data/",
            "nature-figure": "nature-figure/",
            "nature-paper-card": "nature-paper-card/",
            "nature-paper-to-patent": "nature-paper-to-patent/",
            "nature-paper2ppt": "nature-paper2ppt/",
            "nature-polishing": "nature-polishing/",
            "nature-proposal-writer": "nature-proposal-writer/",
            "nature-reader": "nature-reader/",
            "nature-ref-verifier": "nature-ref-verifier/",
            "nature-response": "nature-response/",
            "nature-reviewer": "nature-reviewer/",
            "nature-shared": "nature-shared/",
            "nature-statistics": "nature-statistics/",
            "nature-writing": "nature-writing/",
        },
    },
    "paper-craft-skills-main.zip": {
        "prefix": "paper-craft-skills-main/skills/",
        "skills": {
            "paper-analyzer": "paper-analyzer/",
            "paper-comic": "paper-comic/",
            "paper-deck": "paper-deck/",
        },
    },
}

SKIP_DIR_PARTS = {
    "examples",
    ".github",
    ".claude",
    ".claude-plugin",
    ".codex-plugin",
    ".agents",
    "assets",
    "images",
    "node_modules",
}
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".mp4", ".pdf"}

MATRIX_SECTION = """
## Matrix Agent

Run this skill inside Matrix Agent against the local Paper Matrix library.

1. Find papers in `.sync/catalog.md` or YAML front matter (title, DOI, path). Do not invent papers, DOIs, or citations.
2. Prefer the local Markdown file. Collection papers are read-only. Write outputs to `notes/` or `reviews/`. Never edit `.sync/` or synced paper bodies.
3. If a paper is missing, say it is not in the library. Do not scrape publisher sites, call Paper Matrix APIs, or download full text.
4. Figures live in a sibling `images/` folder. `read` them when methods, results, or slides need the figure. If a file is missing, say it was not synced.
5. Use Pi tools (`read`, `bash`, `edit`, `write`, `read_attachment`). Skip Claude Code, MCP, Feishu, Zotero, Chrome remote-debugging, or cron setup unless the user already has that tool and asks for it.
"""

SEARCH_SKILL = """---
name: nature-academic-search
description: Search and organize literature in the local Paper Matrix library. Use for 文献检索, 查文献, 找文献, catalog search, citation file conversion, and reporting what is missing from the synced library.
---

# Local literature search

## Matrix Agent

Run this skill against the local Paper Matrix library. Do not call Paper Matrix APIs, publisher sites, or MCP search tools unless the user explicitly asks and those tools are already available.

## Workflow

1. Read `.sync/catalog.md` (and `.sync/index.json` if you need structured fields).
2. Filter by folder, tag, year, title, author, DOI, or keyword. Open full text only for the hits you will use.
3. If the user wants a table, build it from front matter: title, authors, year, venue, DOI, tags, folders, relative path.
4. If converting `.bib` / RIS, prefer collection `<folder>.bib` files at the library root and paper `bibtex` front matter. Write extras to `notes/references.bib`.
5. If a paper or citation is not in the library, list it as missing. Do not invent metadata or download PDFs.

## Optional references

Load on demand from this skill directory:

- citation / RIS helpers under `references/`
- conversion scripts under `scripts/`
"""

ACADEMIC_SIBLINGS = (
    "academic-paper",
    "academic-paper-reviewer",
    "academic-pipeline",
    "deep-research",
)


def should_skip_member(name: str) -> bool:
    parts = name.replace("\\", "/").split("/")
    if any(part in SKIP_DIR_PARTS for part in parts):
        return True
    suffix = Path(name).suffix.lower()
    return suffix in SKIP_EXT


def insert_matrix_section(text: str) -> str:
    if "## Matrix Agent" in text:
        return text
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            close = end + len("\n---")
            return text[:close] + "\n" + MATRIX_SECTION + text[close:]
    return MATRIX_SECTION + "\n" + text


def truncate_description(text: str, limit: int = 1000) -> str:
    match = re.search(r"^description:\s*(.*)$", text, re.M)
    if not match:
        return text
    value = match.group(1).strip()
    if value in {">-", "|"}:
        block = re.search(r"^description:\s*(?:>-|\|)\s*\n((?:[ \t].*\n)+)", text, re.M)
        if not block:
            return text
        desc = re.sub(r"\s+", " ", block.group(1)).strip()
        if len(desc) <= limit:
            return text
        desc = desc[: limit - 1].rstrip() + "…"
        return text[: block.start()] + f"description: {desc}\n" + text[block.end() :]
    if len(value.strip("\"'")) <= limit:
        return text
    desc = value.strip("\"'")[: limit - 1].rstrip() + "…"
    return text[: match.start()] + f"description: {desc}" + text[match.end() :]


def rewrite_academic_paths(text: str, skill: str) -> str:
    for sibling in ACADEMIC_SIBLINGS:
        if sibling == skill:
            continue
        text = re.sub(rf"(?<!\.\./){re.escape(sibling)}/", f"../{sibling}/", text)
    text = text.replace(".claude/CLAUDE.md", "the Matrix Agent section above")
    return text


def patch_frontmatter(text: str, skill: str) -> str:
    if skill == "nature-shared" and "disable-model-invocation:" not in text:
        text = text.replace(
            "name: nature-shared\n",
            "name: nature-shared\ndisable-model-invocation: true\n",
            1,
        )
    if skill == "nature-proposal-writer":
        text = re.sub(r"^name:\s*researchwrite\s*$", "name: nature-proposal-writer", text, count=1, flags=re.M)
    return truncate_description(text)


def extract_zip(zip_name: str, spec: dict[str, object]) -> None:
    zip_path = ZIPS_DIR / zip_name
    if not zip_path.exists():
        raise SystemExit(f"missing zip: {zip_path}")
    prefix = spec["prefix"]
    skills: dict[str, str] = spec["skills"]  # type: ignore[assignment]
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename.replace("\\", "/")
            if info.is_dir() or not name.startswith(prefix) or should_skip_member(name):
                continue
            rest = name[len(prefix) :]
            skill = rest.split("/", 1)[0]
            rel = skills.get(skill)
            if rel is None:
                continue
            dest = OUT / rest
            dest.parent.mkdir(parents=True, exist_ok=True)
            data = zf.read(info)
            if dest.name == "SKILL.md" or dest.suffix.lower() in {".md", ".txt", ".yaml", ".yml"}:
                text = data.decode("utf-8", errors="replace")
                if dest.name == "SKILL.md":
                    if skill == "nature-academic-search":
                        text = SEARCH_SKILL
                    else:
                        text = patch_frontmatter(text, skill)
                        text = insert_matrix_section(text)
                        text = rewrite_academic_paths(text, skill)
                else:
                    text = rewrite_academic_paths(text, skill)
                dest.write_text(text, encoding="utf-8", newline="\n")
            else:
                dest.write_bytes(data)


def main() -> None:
    if OUT.exists():
        for child in OUT.iterdir():
            if child.is_dir():
                import shutil

                shutil.rmtree(child)
            else:
                child.unlink()
    OUT.mkdir(parents=True, exist_ok=True)
    for zip_name, spec in ZIPS.items():
        extract_zip(zip_name, spec)
    skills = sorted(p.name for p in OUT.iterdir() if p.is_dir())
    missing = [name for name in skills if not (OUT / name / "SKILL.md").exists()]
    if missing:
        raise SystemExit(f"skills missing SKILL.md: {missing}")
    (OUT / "README.md").write_text(
        "# Bundled Matrix Agent skills\n\n"
        "Adapted from academic-research-skills, nature-skills, and paper-craft-skills.\n"
        "Seeded into `~/.MatrixAgent/skills` on first launch if the skill folder is absent.\n\n"
        "Skipped as incompatible with the local Paper Matrix library:\n"
        "- nature-downloader\n"
        "- nature-literature-pipeline\n"
        "- nature-image2ppt\n"
        "- nature-experiment-log\n",
        encoding="utf-8",
    )
    print(f"wrote {len(skills)} skills to {OUT}")
    for name in skills:
        files = list((OUT / name).rglob("*"))
        size = sum(p.stat().st_size for p in files if p.is_file())
        print(f"  {name}: {sum(1 for p in files if p.is_file())} files, {size/1024:.1f} KB")


if __name__ == "__main__":
    main()
