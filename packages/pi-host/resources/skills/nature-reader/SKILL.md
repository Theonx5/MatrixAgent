---
name: nature-reader
description: Build full-paper Chinese-English side-by-side, figure/table/equation-aware, source-grounded Markdown readers for journal or conference papers from PDF, DOI, arXiv, publisher HTML, or pasted text. Use whenever the user asks to translate or read a paper, make 中英文对照/原文对照/全文翻译解读, render equations instead of exposing raw LaTeX, extract figures or tables into the right positions, preserve figure/table placement near relevant prose, or keep exact source anchors for every block. This skill must not degrade into a summary-only output unless the user explicitly asks for a summary. Also trigger on general paper-reading and translation requests even without the word "Nature", such as reading/translating an academic paper, literature reading, understanding a paper, and Chinese phrasings like 读论文、精读论文、论文翻译、文献翻译、文献阅读、学术阅读、帮我读这篇文章、翻译这篇paper.
metadata:
  version: "2.1.1"
  author: Community contribution, refactored into static/dynamic layers
---

## Matrix Agent

Run this skill inside Matrix Agent against the local Paper Matrix library.

1. Find papers in `.sync/catalog.md` or YAML front matter (title, DOI, path). Do not invent papers, DOIs, or citations.
2. Prefer the local Markdown file. Collection papers are read-only. Write outputs to `notes/` or `reviews/`. Never edit `.sync/` or synced paper bodies.
3. If a paper is missing, say it is not in the library. Do not scrape publisher sites, call Paper Matrix APIs, or download full text.
4. Figures live in a sibling `images/` folder. `read` every figure you will discuss. If a file is missing, say it was not synced.
5. Use Pi tools (`read`, `bash`, `edit`, `write`, `read_attachment`). Skip Claude Code, MCP, Feishu, Zotero, Chrome remote-debugging, or cron setup unless the user already has that tool and asks for it.


# Full-Paper Markdown Reader — Router

This skill is split into two layers:

- A **static layer** under `static/` that holds versioned, reusable content fragments (core principles, the reading workflow, the output contract, and per-source-format extraction guidance).
- A **dynamic layer** (this file plus `manifest.yaml`) that detects the request's source format and loads only the fragments needed for the current job.

Do not try to apply the reading logic from memory or from this router. Always load fragments from disk as described below.

## Routing protocol

Follow these five steps every time the skill is invoked.

### 1. Load the manifest and the core layer

Read [manifest.yaml](manifest.yaml). It declares the `source_format` axis, the allowed values, and the file paths each value maps to.

Also read every file listed under `always_load`. These hold the core principles, the reading workflow, and the output contract that apply to every reading job, plus the shared Terminology Ledger used to build the recurring-term table.

### 2. Detect the source format

Decide the `source_format` value using the manifest's `detect:` hint and the user's input:

- `local-md` — synced Paper Matrix Markdown plus sibling `images/`. Default.
- `pdf-text` — selectable-text PDF attachment.
- `scanned-pdf` — image-only or OCR-required PDF.
- `html` — publisher or preprint HTML page (only if the paper is not local).
- `doi-arxiv` — a bare DOI or arXiv link that is not in the local library.
- `pasted-text` — pasted prose or notes with no retrievable original layout.

State the detected value in one short line to the user before processing, so they can correct you cheaply. A source may map to more than one value (for example a DOI that resolves to a PDF); load the resolution fragment first, then the fragment for the resolved artifact.

### 3. Load the matching fragment(s)

Read the file mapped for the detected `source_format`. Do **not** read every fragment in `static/`. Load only what step 2 selected.

### 4. Build the reader using the loaded material

Apply the loaded fragments in this priority order:

1. Core principles (`core/principles.md`) — bilingual reader by default, translate for meaning, never degrade to a summary, copyright caution.
2. Source-format fragment — how to extract text, figures, and tables for this input.
3. Reading workflow (`core/workflow.md`) — the six-step source-map-first process.
4. Output contract (`core/output-contract.md`) — required files and the pre-response verification checklist.

Build the Terminology Ledger as you translate (`../nature-shared/core/terminology-ledger.md`); it becomes the `paper.md` recurring-term table and the `source_map.json` glossary.

If constraints prevent full processing, still create a draft reader and label missing pages, figures, or low-confidence crops in `translation_notes.md`. Do not switch to summary mode.

### 5. Reach for references only when needed

The files under `references/` are deep references, not defaults. Open them on demand per the `references.on_demand` table in the manifest:

- detailed figure/table cropping and placement → `references/figure-extraction.md`.
- exact field schema for `paper.md` / `source_map.json` → `references/output-spec.md`.
- equations, mathematical expressions, chemical formulae, or image-only formulae → `references/equation-handling.md`.
- answering follow-up questions with source citations → `references/grounding-rules.md`.

## Why this split

- The static layer is versioned and reviewable. Adding a new source format is one new fragment plus one manifest line.
- The dynamic layer keeps each invocation cheap: only the fragment relevant to this input enters context.
- The router itself is short on purpose. Update fragments, not this file, when adding scope.
- This structure mirrors `nature-writing` and `nature-polishing` so shared content lives in `nature-shared/`.
