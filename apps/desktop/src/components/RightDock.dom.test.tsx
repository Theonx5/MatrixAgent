/** @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import type { DesktopSettings, WorkspaceSnapshot } from "@pideck/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../lib/stores/app-store";
import { requestDockBrowser } from "../lib/dock-browser";
import { requestDockTextPreview } from "../lib/dock-text";
import { clearPendingTreePanelForTest, requestTreePanel } from "../lib/dock-tree";

vi.mock("../features/dock/ShellTerminal", () => ({
  ShellTerminal: ({ profileId, visible }: { profileId: string; visible: boolean }) => (
    <div data-testid="shell-terminal" data-profile={profileId} hidden={!visible} />
  ),
  shellTerminalLabel: (cwd: string) => cwd,
}));

vi.mock("../features/dock/ExtensionTerminal", () => ({
  ExtensionTerminal: () => null,
  cancelExtensionTerminal: vi.fn(async () => null),
  forceCloseExtensionTerminal: vi.fn(async () => null),
}));

vi.mock("../features/dock/BrowserPanel", () => ({
  BrowserPanel: ({ initialUrl }: { initialUrl?: string }) => (
    <div data-testid="browser-panel" data-initial-url={initialUrl} />
  ),
}));

vi.mock("../features/dock/TextPreviewPanel", () => ({
  TextPreviewPanel: ({ path }: { path: string }) => (
    <div data-testid="text-preview" data-path={path} />
  ),
  isPreviewableFileName: (path: string) => /\.(?:md|markdown|txt)$/i.test(path),
}));

vi.mock("../features/dock/ChangesPanel", () => ({
  ChangesPanel: ({ visible }: { visible: boolean }) => (
    <div data-testid="changes-panel" hidden={!visible} />
  ),
}));

import { RightDock } from "./RightDock";
import { ChatHeader } from "../features/chat/ChatHeader";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

function settings(terminalProfile: string, language: "en" | "zh" = "en"): DesktopSettings {
  return { terminalProfile, language } as DesktopSettings;
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    value: {},
    configurable: true,
  });
  useAppStore.setState({
    dockOpen: true,
    extensionTerminal: null,
    workspace: { canonicalCwd: "/workspace" } as WorkspaceSnapshot,
    desktopSettings: settings("auto"),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  clearPendingTreePanelForTest();
});

async function openAddMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "New dock page" }));
  return screen.getByRole("menu");
}

describe("RightDock pages", () => {
  it("starts without an active page", () => {
    render(<RightDock />);

    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.getByRole("button", { name: "Open Files" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Changes" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Browser" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Terminal" })).toBeVisible();
  });

  it("keeps the new-page menu in the dock header stacking context", async () => {
    const user = userEvent.setup();
    render(<RightDock />);
    await user.click(screen.getByRole("button", { name: "Open Files" }));
    const menu = await openAddMenu(user);
    expect(menu).toBeVisible();
    expect(menu.closest("[data-right-dock]")).toHaveClass("z-30");
    expect(menu.closest("[data-dock-header]")).toHaveClass("z-50");
  });

  it("localizes Dock navigation and shortcuts in Chinese", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ desktopSettings: settings("auto", "zh") });
    render(
      <>
        <ChatHeader />
        <RightDock />
      </>,
    );

    expect(screen.getByRole("button", { name: "收起右侧面板" })).toHaveAttribute(
      "title",
      "收起面板 (Ctrl+J)",
    );
    expect(screen.getByRole("button", { name: "打开：文件" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开：会话树" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开：改动" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开：浏览器" })).toBeVisible();
    expect(screen.getByRole("button", { name: "打开：终端" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "新建 Dock 页面" }));
    expect(screen.getByRole("menuitem", { name: "文件" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "会话树" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "改动" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "浏览器" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "终端" })).toBeVisible();

    await user.click(screen.getByRole("menuitem", { name: "浏览器" }));
    expect(screen.getByRole("tab", { name: "浏览器" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "关闭：浏览器" })).toBeVisible();
  });

  it("moves the toolbar toggle with the chat edge as the Dock opens and closes", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <>
        <ChatHeader />
        <RightDock />
      </>,
    );
    const header = container.querySelector<HTMLElement>("[data-chat-header]")!;

    expect(header).toHaveAttribute("data-dock-open", "true");
    expect(header).toHaveClass("pr-2");

    await user.click(screen.getByRole("button", { name: "Collapse right panel" }));

    expect(useAppStore.getState().dockOpen).toBe(false);
    expect(header).toHaveAttribute("data-dock-open", "false");
    expect(header).toHaveClass("pr-[140px]");
    expect(screen.getByRole("button", { name: "Open right panel" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.getByRole("button", { name: "Open right panel" })).toHaveAttribute(
      "aria-controls",
      "right-dock",
    );
    expect(container.querySelector("#right-dock")).toBeInTheDocument();
    expect(container.querySelector("[data-dock-toolbar-toggle]")).toBeVisible();
  });

  it("opens each tool from the empty-state shortcuts", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await user.click(screen.getByRole("button", { name: "Open Files" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Close Files" }));

    await user.click(screen.getByRole("button", { name: "Open Changes" }));
    expect(screen.getByRole("tab", { name: "Changes" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Close Changes" }));

    await user.click(screen.getByRole("button", { name: "Open Browser" }));
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("button", { name: "Close Browser" }));

    await user.click(screen.getByRole("button", { name: "Open Terminal" }));
    expect(screen.getByRole("tab", { name: "Shell - /workspace" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("keeps the add menu inside the Dock as tabs appear", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    expect(await openAddMenu(user)).toHaveClass("left-0");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Open Files" }));
    expect(await openAddMenu(user)).toHaveClass("right-0");
  });

  it("keeps Files as a closable singleton", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));

    expect(screen.getAllByRole("tab", { name: "Files" })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Close Files" }));
    expect(screen.queryByRole("tab", { name: "Files" })).toBeNull();
  });

  it("limits Browser pages to eight", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    for (let index = 0; index < 8; index += 1) {
      await openAddMenu(user);
      await user.click(screen.getByRole("menuitem", { name: "Browser" }));
    }
    await openAddMenu(user);

    expect(screen.getAllByRole("button", { name: "Close Browser" })).toHaveLength(8);
    expect(screen.getByRole("menuitem", { name: "Browser" })).toBeDisabled();
    expect(requestDockBrowser({ url: "https://example.com/ninth" })).toBe(false);
    expect(screen.getAllByTestId("browser-panel")).toHaveLength(8);
  });

  it("opens consecutive URL requests in new active Browser pages", async () => {
    useAppStore.setState({ dockOpen: false });
    render(<RightDock />);

    act(() => {
      expect(requestDockBrowser({ url: "https://one.example/path" })).toBe(true);
      expect(requestDockBrowser({ url: "https://two.example/path" })).toBe(true);
    });

    await waitFor(() => expect(screen.getAllByTestId("browser-panel")).toHaveLength(2));
    expect(screen.getAllByTestId("browser-panel").map((panel) => panel.dataset.initialUrl)).toEqual(
      ["https://one.example/path", "https://two.example/path"],
    );
    const tabs = screen.getAllByRole("tab", { name: "Browser" });
    expect(tabs.at(-1)).toHaveAttribute("aria-selected", "true");
    expect(useAppStore.getState().dockOpen).toBe(true);
  });

  it("activates the adjacent page after closing the current page", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Files" }));
    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Browser" }));
    expect(screen.getByRole("tab", { name: "Browser" })).toHaveAttribute("aria-selected", "true");

    await user.click(screen.getByRole("button", { name: "Close Browser" }));
    expect(screen.getByRole("tab", { name: "Files" })).toHaveAttribute("aria-selected", "true");
  });

  it("captures the configured Shell profile when each Terminal is created", async () => {
    const user = userEvent.setup();
    useAppStore.setState({ desktopSettings: settings("fish") });
    render(<RightDock />);

    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));
    act(() => useAppStore.setState({ desktopSettings: settings("zsh") }));
    await openAddMenu(user);
    await user.click(screen.getByRole("menuitem", { name: "Terminal" }));

    await waitFor(() => {
      expect(screen.getAllByTestId("shell-terminal").map((node) => node.dataset.profile)).toEqual([
        "fish",
        "zsh",
      ]);
    });
  });

  it("supports keyboard navigation in the add menu", async () => {
    const user = userEvent.setup();
    render(<RightDock />);

    await openAddMenu(user);
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Files" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Session tree" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Changes" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Browser" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Terminal" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "New dock page" })).toHaveFocus();
  });

  it("opens the Tree page as a singleton via requestTreePanel", async () => {
    useAppStore.setState({ dockOpen: false });
    render(<RightDock />);

    act(() => requestTreePanel());
    expect(await screen.findByRole("tab", { name: "Tree" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(useAppStore.getState().dockOpen).toBe(true);

    act(() => requestTreePanel());
    expect(screen.getAllByRole("tab", { name: "Tree" })).toHaveLength(1);
  });
});

describe("RightDock text previews", () => {
  it("opens, focuses, and closes text preview pages from requests", async () => {
    useAppStore.setState({ dockOpen: false });
    render(<RightDock />);

    act(() => {
      expect(requestDockTextPreview({ path: "README.md", name: "README.md" })).toBe(true);
      expect(requestDockTextPreview({ path: "README.md", name: "README.md" })).toBe(true);
      expect(requestDockTextPreview({ path: "docs/notes.txt", name: "notes.txt" })).toBe(true);
    });

    await waitFor(() => expect(screen.getAllByTestId("text-preview")).toHaveLength(2));
    expect(screen.getAllByTestId("text-preview").map((panel) => panel.dataset.path)).toEqual([
      "README.md",
      "docs/notes.txt",
    ]);
    const tabs = screen.getAllByRole("tab", { name: "notes.txt" });
    expect(tabs.at(-1)).toHaveAttribute("aria-selected", "true");
    expect(useAppStore.getState().dockOpen).toBe(true);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close notes.txt" }));
    await waitFor(() => expect(screen.getAllByTestId("text-preview")).toHaveLength(1));
    expect(screen.queryByRole("tab", { name: "notes.txt" })).toBeNull();
    expect(screen.getByRole("tab", { name: "README.md" })).toBeVisible();
  });

  it("limits text preview pages to twelve", async () => {
    render(<RightDock />);

    act(() => {
      for (let index = 0; index < 12; index += 1) {
        expect(
          requestDockTextPreview({ path: `file-${index}.txt`, name: `file-${index}.txt` }),
        ).toBe(true);
      }
      expect(requestDockTextPreview({ path: "overflow.txt", name: "overflow.txt" })).toBe(false);
    });
    await waitFor(() => expect(screen.getAllByTestId("text-preview")).toHaveLength(12));
  });

  it("activates an existing preview tab for the same path", async () => {
    render(<RightDock />);

    act(() => {
      requestDockTextPreview({ path: "a.md", name: "a.md" });
      requestDockTextPreview({ path: "b.md", name: "b.md" });
    });
    await waitFor(() => expect(screen.getAllByTestId("text-preview")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "b.md" })).toHaveAttribute("aria-selected", "true"),
    );

    act(() => requestDockTextPreview({ path: "a.md", name: "a.md" }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "a.md" })).toHaveAttribute("aria-selected", "true"),
    );
    expect(screen.getAllByTestId("text-preview")).toHaveLength(2);
  });
});
