---
name: nature-shared
disable-model-invocation: true
description: Internal shared-reference support package for installed Nature Skills, including nature-writing, nature-polishing, nature-response, nature-reader, and nature-paper2ppt. Do not invoke it as a standalone user workflow. Load only the specific core or journal-format file requested by another Nature skill.
---

## Matrix Agent

Run this skill inside Matrix Agent against the local Paper Matrix library.

1. Find papers in `.sync/catalog.md` or YAML front matter (title, DOI, path). Do not invent papers, DOIs, or citations.
2. Prefer the local Markdown file. Collection papers are read-only. Write outputs to `notes/` or `reviews/`. Never edit `.sync/` or synced paper bodies.
3. If a paper is missing, say it is not in the library. Do not scrape publisher sites, call Paper Matrix APIs, or download full text.
4. Figures live in a sibling `images/` folder. Read them when needed; if a file is missing, say so.
5. Use Pi tools (`read`, `bash`, `edit`, `write`, `read_attachment`). Skip Claude Code, MCP, Feishu, Zotero, Chrome remote-debugging, or cron setup unless the user already has that tool and asks for it.


# Nature Shared References

Use this package only as a dependency of another installed Nature skill.

- Load the exact referenced file; do not preload the whole package.
- Treat `core/` and `journal-formats/` as shared definitions, not standalone workflows.
- Use `journal-formats/nature.md` only for the flagship journal Nature and
  `core/research-compliance.md` only when its specialist applicability gate is
  triggered.
- Use `journal-formats/nature-machine-intelligence.md` for exact NMI article
  types, limits, initial-submission files, data/code duties and production
  requirements; do not import flagship Nature or Nature Communications limits.
- Use `core/main-text-discipline.md` for result placement, main-text compression,
  revision accretion, caption/SI allocation, and claim-repetition checks.
- Use `core/nature-results-discussion.md` for corpus-derived Nature-style
  Results claim escalation, evidence-bound local interpretation, and Discussion
  synthesis; do not present it as official journal policy.
- Use `core/discussion-argument-language.md` for journal-general Discussion
  function sequencing, reverse-funnel control, evidence-calibrated modality,
  claim-specific limitations, and uncertainty-driven future work.
- Use `core/nature-introduction.md` for corpus-derived Nature-style problem
  funnels, exact knowledge gaps, literature tension, question-first novelty,
  and Introduction–Results alignment; do not present it as official journal
  policy.
- Use `core/nature-abstract.md` for corpus-derived Nature-style
  discovery-centred abstract compression, claim hierarchy, selective numeric
  support, and field-level payoff; do not present it as official journal policy.
- Return to the requesting skill for task logic, output format, and final QA.
