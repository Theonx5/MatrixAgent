/** @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../lib/stores/app-store";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  subscribeEvent: vi.fn(() => () => {}),
}));

vi.mock("../../lib/bridge/host-client", () => ({
  hostClient: { request: mocks.request },
}));

vi.mock("../../lib/bridge/host-context", () => ({
  workspaceContext: () => ({ context: true }),
}));

vi.mock("../../lib/bridge/validated-host-events", () => ({
  subscribeValidatedHostEvent: mocks.subscribeEvent,
}));

vi.mock("../chat/MarkdownMessage", () => ({
  MarkdownMessage: ({ content }: { content: string }) => (
    <div data-testid="markdown-message">{content}</div>
  ),
}));

import { TextPreviewPanel } from "./TextPreviewPanel";

type LoadResult = {
  ok: boolean;
  result?: { path: string; content: string; size: number; truncated: boolean; binary: boolean };
  error?: { message: string };
};

function resolveWith(result: LoadResult) {
  mocks.request.mockResolvedValue(result);
}

beforeEach(() => {
  useAppStore.setState({
    host: { hostInstanceId: "host-1" } as never,
    workspace: { id: "ws-1", revision: 1 } as never,
  });
  mocks.request.mockReset();
  mocks.subscribeEvent.mockClear();
  mocks.subscribeEvent.mockImplementation(() => () => {});
});

afterEach(() => {
  cleanup();
});

function textResult(overrides: Partial<NonNullable<LoadResult["result"]>> = {}) {
  return {
    ok: true as const,
    result: {
      path: "README.md",
      content: "# Hello",
      size: 7,
      truncated: false,
      binary: false,
      ...overrides,
    },
  };
}

describe("TextPreviewPanel", () => {
  it("renders markdown files through the markdown renderer", async () => {
    resolveWith(textResult({ content: "# Hello\n\nworld", path: "README.md" }));
    render(<TextPreviewPanel path="README.md" visible={true} />);

    await waitFor(() => expect(screen.getByTestId("markdown-message")).toBeInTheDocument());
    expect(screen.getByTestId("markdown-message")).toHaveTextContent("# Hello");
  });

  it("renders plain text files as preformatted text", async () => {
    resolveWith(textResult({ content: "line one\nline two", path: "notes.txt" }));
    render(<TextPreviewPanel path="notes.txt" visible={true} />);

    await waitFor(() => {
      const pre = screen.getByText((_, element) =>
        element?.tagName === "PRE" ? /line one\nline two/.test(element.textContent ?? "") : false,
      );
      expect(pre).toBeInTheDocument();
    });
    expect(screen.queryByTestId("markdown-message")).toBeNull();
  });

  it("shows a binary notice without rendering content", async () => {
    resolveWith(textResult({ binary: true, content: "", path: "asset.bin" }));
    render(<TextPreviewPanel path="asset.bin" visible={true} />);

    await waitFor(() =>
      expect(screen.getByText("Binary files cannot be previewed.")).toBeVisible(),
    );
  });

  it("shows an empty notice for empty files", async () => {
    resolveWith(textResult({ content: "", path: "empty.txt" }));
    render(<TextPreviewPanel path="empty.txt" visible={true} />);

    await waitFor(() => expect(screen.getByText("This file is empty.")).toBeVisible());
  });

  it("shows an error with retry after a failed read", async () => {
    resolveWith({ ok: false, error: { message: "Unable to read file" } });
    const user = userEvent.setup();
    render(<TextPreviewPanel path="README.md" visible={true} />);

    await waitFor(() => expect(screen.getByText("Unable to read file")).toBeVisible());
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();

    resolveWith(textResult());
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByTestId("markdown-message")).toBeInTheDocument());
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });

  it("shows a truncation notice when the result is capped", async () => {
    resolveWith(textResult({ truncated: true, content: "partial" }));
    render(<TextPreviewPanel path="README.md" visible={true} />);

    await waitFor(() => expect(screen.getByText(/Preview truncated/)).toBeInTheDocument());
  });

  it("requests the file content for the given path", async () => {
    resolveWith(textResult());
    render(<TextPreviewPanel path="docs/guide.md" visible={true} />);

    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
    const [method, context, params] = mocks.request.mock.calls[0]!;
    expect(method).toBe("workspace.readTextFile");
    expect(context).toEqual({ context: true });
    expect(params).toEqual({ path: "docs/guide.md" });
  });
});
