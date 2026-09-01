import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, LoaderCircle, RefreshCw } from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { workspaceContext } from "../../lib/bridge/host-context";
import { subscribeValidatedHostEvent } from "../../lib/bridge/validated-host-events";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { MarkdownMessage } from "../chat/MarkdownMessage";

const MARKDOWN_EXTENSIONS = /\.(?:md|markdown)$/i;
const PLAIN_TEXT_EXTENSIONS = /\.(?:txt|log|text)$/i;

/** File-name classifier shared with the Files panel preview affordance. */
export function isPreviewableFileName(path: string): boolean {
  return MARKDOWN_EXTENSIONS.test(path) || PLAIN_TEXT_EXTENSIONS.test(path);
}

function isMarkdownFile(path: string): boolean {
  return MARKDOWN_EXTENSIONS.test(path);
}

export function TextPreviewPanel({ path, visible }: { path: string; visible: boolean }) {
  const t = useT();
  const host = useAppStore((state) => state.host);
  const workspace = useAppStore((state) => state.workspace);
  const [state, setState] = useState<{
    loading: boolean;
    content: string;
    truncated: boolean;
    binary: boolean;
    error: string | null;
  }>({ loading: true, content: "", truncated: false, binary: false, error: null });
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!host || !workspace) return;
    const current = useAppStore.getState();
    if (!current.host || !current.workspace) return;
    const generation = ++loadGeneration.current;
    setState((prev) => ({ ...prev, loading: true }));
    try {
      const response = await hostClient.request(
        "workspace.readTextFile",
        workspaceContext(current.host, current.workspace),
        { path },
      );
      if (generation !== loadGeneration.current) return;
      if (!response.ok) {
        throw new Error(response.error?.message ?? t("dockTextPreviewFailed"));
      }
      setState({
        loading: false,
        content: response.result.content,
        truncated: response.result.truncated,
        binary: response.result.binary,
        error: null,
      });
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error: error instanceof Error ? error.message : t("dockTextPreviewFailed"),
      }));
    }
  }, [host, path, t, workspace]);

  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  // Re-read when the watched directory reports a change while visible.
  useEffect(() => {
    if (!host || !workspace || !visible) return;
    const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    return subscribeValidatedHostEvent(
      "workspace.filesChanged",
      workspaceContext(host, workspace),
      (event) => {
        if (event.payload.directories.includes(directory)) void load();
      },
    );
  }, [host, workspace, visible, path, load]);

  const name = path.slice(path.lastIndexOf("/") + 1);
  const markdown = isMarkdownFile(path);

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-surface"
      aria-label={t("dockTextPreviewRegion", { name })}
      data-text-preview
      data-path={path}
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <FileText size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs" title={path}>
          {name}
        </span>
        <button
          type="button"
          title={t("dockTextPreviewRefresh")}
          aria-label={t("dockTextPreviewRefresh")}
          className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {state.loading ? (
          <div className="flex h-full items-center justify-center text-muted">
            <LoaderCircle size={16} className="animate-spin" />
          </div>
        ) : state.error ? (
          <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-xs text-muted">
            <span>{state.error}</span>
            <button
              type="button"
              className="rounded border border-border px-2 py-1 text-foreground hover:bg-surface-overlay"
              onClick={() => void load()}
            >
              {t("dockRetry")}
            </button>
          </div>
        ) : state.binary ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            {t("dockTextPreviewBinary")}
          </div>
        ) : state.content.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted">
            {t("dockTextPreviewEmpty")}
          </div>
        ) : markdown ? (
          <div className="mx-auto max-w-[72ch] pb-6 text-sm">
            <MarkdownMessage content={state.content} mode="static" />
          </div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-foreground/90">
            {state.content}
          </pre>
        )}
      </div>

      {state.truncated && !state.error ? (
        <div className="shrink-0 border-t border-border px-4 py-2 text-[11px] text-muted">
          {t("dockTextPreviewTruncated")}
        </div>
      ) : null}
    </section>
  );
}
