# Source: local Paper Matrix Markdown

The paper is already synced as Markdown in the library. This is the default Matrix Agent source.

- Locate the paper from `.sync/catalog.md` or YAML front matter (title, DOI, path).
- Read the local Markdown file. Do not download a PDF or publisher HTML unless the user explicitly asks and the file is not in the library.
- Resolve `images/...` links against the paper's folder. The parsed figures live in the sibling `images/` directory (for example `LLM/images/img_0.jpg`).
- `read` each figure file you will discuss. If the directory or a linked file is missing, mark that figure as not synced; do not invent it or scrape the publisher.
- Keep the original MinerU relative links in the bilingual reader so they still resolve next to the source paper. When writing a copy under `notes/` or `reviews/`, copy only the selected figure files you need; never edit the synced `images/` folder.
- Tables that are already Markdown stay as Markdown. Image-only tables remain image files from `images/`.
- Treat this as `structure-grounded` evidence: cite figure filenames and paper relative paths, not PDF page numbers.
