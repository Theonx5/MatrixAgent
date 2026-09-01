/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SerializableAgentMessage } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { subscribeDockText } from "../../lib/dock-text";

const opened: Array<{ path: string; name: string }> = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { ArtifactsPanel } from "./ArtifactsPanel";

beforeEach(() => {
  opened.length = 0;
  subscribeDockText((request) => {
    opened.push(request);
    return true;
  });
  useAppStore.setState({
    workspace: { canonicalCwd: "C:/work/project", id: "ws", revision: 1 } as never,
    host: { hostInstanceId: "host" } as never,
  });
});

afterEach(() => {
  cleanup();
});

function writeMessage(path: string, endedAt: number): SerializableAgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: `t-${path}-${endedAt}`,
        name: "write",
        arguments: JSON.stringify({ path }),
        startedAt: endedAt - 10,
        endedAt,
      },
    ],
  };
}

describe("ArtifactsPanel", () => {
  it("lists session artifacts newest first and opens preview on click", async () => {
    useAppStore.setState({
      session: {
        messages: [
          writeMessage("C:/work/project/outline.md", 20),
          writeMessage("C:/work/project/notes/summary.txt", 40),
        ],
      } as never,
    });
    const user = userEvent.setup();
    render(<ArtifactsPanel />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("summary.txt");
    expect(items[1]).toHaveTextContent("outline.md");

    await user.click(screen.getByRole("button", { name: "Preview outline.md" }));
    expect(opened).toEqual([{ path: "outline.md", name: "outline.md" }]);
  });

  it("shows an empty state when the session has no artifacts", () => {
    useAppStore.setState({ session: { messages: [] } as never });
    render(<ArtifactsPanel />);

    expect(
      screen.getByText("No md/txt artifacts written by Matrix in this session yet."),
    ).toBeVisible();
  });

  it("prompts for a workspace when none is open", () => {
    useAppStore.setState({ workspace: null });
    render(<ArtifactsPanel />);

    expect(screen.getByText("No workspace open")).toBeVisible();
  });
});
