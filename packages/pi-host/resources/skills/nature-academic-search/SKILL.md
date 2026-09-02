---
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
