import { useMemo } from "react";
import { FileText, FileOutput, FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import { collectArtifacts } from "../../lib/artifacts";
import { requestDockTextPreview } from "../../lib/dock-text";
import { workspaceAbsolutePath } from "./FilesPanel";

export function ArtifactsPanel() {
  const t = useT();
  const workspace = useAppStore((state) => state.workspace);
  const messages = useAppStore((state) => state.session?.messages ?? []);
  const canonicalCwd = workspace?.canonicalCwd ?? "";
  const artifacts = useMemo(
    () => collectArtifacts(messages, canonicalCwd),
    [messages, canonicalCwd],
  );

  const openPreview = (path: string) => {
    requestDockTextPreview({ path, name: path.slice(path.lastIndexOf("/") + 1) });
  };

  const reveal = async (path: string) => {
    if (!workspace) return;
    try {
      await invoke("desktop_open_path", {
        path: workspaceAbsolutePath(workspace.canonicalCwd, path),
      });
    } catch {
      /* the file manager may be unavailable; ignore */
    }
  };

  if (!workspace) {
    return (
      <section
        className="flex min-h-0 flex-1 flex-col bg-surface"
        aria-label={t("dockArtifactsRegion")}
        data-artifacts-panel
      >
        <div className="flex flex-1 items-center justify-center text-xs text-muted">
          {t("dockNoWorkspace")}
        </div>
      </section>
    );
  }

  return (
    <section
      className="flex min-h-0 flex-1 flex-col bg-surface"
      aria-label={t("dockArtifactsRegion")}
      data-artifacts-panel
    >
      <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border px-3">
        <FileOutput size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate text-xs text-muted">
          {t("dockArtifactsRegion")}
        </span>
        <span className="shrink-0 text-[10px] text-muted">{artifacts.length}</span>
      </div>

      {artifacts.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-xs text-muted">
          <FileOutput size={20} className="opacity-60" />
          <span>{t("dockArtifactsEmpty")}</span>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1" role="list">
          {artifacts.map((artifact) => (
            <div
              key={artifact.path}
              role="listitem"
              className="group flex h-9 w-full items-center px-2 text-xs hover:bg-surface-overlay/60"
            >
              <FileText size={14} className="mr-2 shrink-0 text-accent" />
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                title={t("dockFilesPreviewNamed", { path: artifact.path })}
                aria-label={t("dockFilesPreviewNamed", { path: artifact.path })}
                onClick={() => openPreview(artifact.path)}
              >
                <span className="block truncate font-medium text-foreground/90 group-hover:text-foreground">
                  {artifact.name}
                </span>
                <span className="block truncate text-[10px] text-muted" title={artifact.path}>
                  {artifact.path}
                </span>
              </button>
              <button
                type="button"
                title={t("dockFilesReveal")}
                aria-label={t("dockFilesRevealNamed", { path: artifact.path })}
                className="ml-1 hidden size-6 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-foreground group-hover:flex"
                onClick={() => void reveal(artifact.path)}
              >
                <FolderOpen size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
