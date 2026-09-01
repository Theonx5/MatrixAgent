/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";
import { subscribeDockText } from "../../lib/dock-text";

const opened: Array<{ path: string; name: string }> = [];

vi.mock("../chat/markdown-utils", () => ({
  sanitizeAgentText: (value: string) => value,
}));

import { FileMutationToolCard, FileReadToolCard } from "./CodingToolCards";

beforeEach(() => {
  opened.length = 0;
  subscribeDockText((request) => {
    opened.push(request);
    return true;
  });
  useAppStore.setState({
    workspace: { canonicalCwd: "C:/work/project", id: "ws", revision: 1 } as never,
  });
});

afterEach(() => {
  cleanup();
});

describe("clickable file paths in tool cards", () => {
  it("opens a dock preview when clicking a written markdown path", async () => {
    const user = userEvent.setup();
    render(
      <FileMutationToolCard
        name="write"
        args={JSON.stringify({ path: "C:/work/project/outline.md", content: "# hi" })}
        details={JSON.stringify({ patch: "+# hi" })}
        status="done"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview outline.md" }));
    expect(opened).toEqual([{ path: "outline.md", name: "outline.md" }]);
  });

  it("does not offer a preview for non-previewable or external files", () => {
    render(
      <FileMutationToolCard
        name="edit"
        args={JSON.stringify({ path: "C:/work/project/app.py", oldText: "a", newText: "b" })}
        details={JSON.stringify({ patch: "-a\n+b" })}
        status="done"
      />,
    );
    render(
      <FileMutationToolCard
        name="write"
        args={JSON.stringify({ path: "C:/elsewhere/notes.md", content: "x" })}
        details={JSON.stringify({ patch: "+x" })}
        status="done"
      />,
    );

    expect(screen.queryByRole("button", { name: /Preview /u })).toBeNull();
    expect(opened).toEqual([]);
  });

  it("opens a dock preview from a read tool card path", async () => {
    const user = userEvent.setup();
    render(
      <FileReadToolCard
        name="read"
        args={JSON.stringify({ path: "C:/work/project/README.md" })}
        result="readme text"
        status="done"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Preview README.md" }));
    expect(opened).toEqual([{ path: "README.md", name: "README.md" }]);
  });
});
