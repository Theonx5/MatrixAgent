import { useState } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { SectionHeader } from "../../components/SectionHeader";
import { Switch } from "../../components/Switch";
import { useT } from "../../lib/i18n/use-t";
import { deleteMatrixPassword, storeMatrixPassword } from "../../lib/matrix-secrets";
import { formatChinaDateTime } from "../../lib/format-china-datetime";

export function MatrixSettings() {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const matrix = useAppStore((s) => s.matrix);
  const setMatrixStatus = useAppStore((s) => s.setMatrixStatus);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [username, setUsername] = useState(matrix?.user?.username ?? "");
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(matrix?.rememberPassword ?? false);
  const [busy, setBusy] = useState<"login" | "logout" | "sync" | "settings" | null>(null);
  const [pollText, setPollText] = useState(String(matrix?.pollIntervalMin ?? 30));

  async function run<T>(kind: typeof busy, task: () => Promise<T>): Promise<T | undefined> {
    if (!host) return undefined;
    setBusy(kind);
    try {
      return await task();
    } finally {
      setBusy(null);
    }
  }

  async function login() {
    if (!host) return;
    try {
      const response = await run("login", () =>
        hostClient.request(
          "matrix.login",
          hostContext(host),
          { username: username.trim(), password, rememberPassword },
          30_000,
        ),
      );
      if (!response) return;
      if (!response.ok) {
        pushNotification(response.error.message || t("matrixLoginFailed"), "error");
        return;
      }
      setMatrixStatus(response.result);
      if (rememberPassword) await storeMatrixPassword(username.trim(), password);
      else await deleteMatrixPassword(username.trim());
      setPassword("");
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("matrixLoginFailed"), "error");
    }
  }

  async function logout() {
    if (!host) return;
    const currentUser = matrix?.user?.username;
    try {
      const response = await run("logout", () =>
        hostClient.request("matrix.logout", hostContext(host), null, 15_000),
      );
      if (!response) return;
      if (!response.ok) {
        pushNotification(response.error.message, "error");
        return;
      }
      setMatrixStatus(response.result);
      if (currentUser) await deleteMatrixPassword(currentUser);
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("matrixLoginFailed"), "error");
    }
  }

  async function syncNow() {
    if (!host) return;
    try {
      const response = await run("sync", () =>
        hostClient.request("matrix.syncNow", hostContext(host), null, 10 * 60_000),
      );
      if (!response) return;
      if (!response.ok) {
        pushNotification(response.error.message || t("matrixSyncFailed"), "error");
        return;
      }
      setMatrixStatus(response.result);
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("matrixSyncFailed"), "error");
    }
  }

  async function patchSettings(patch: {
    libraryRoot?: string;
    pollIntervalMin?: number;
    withAbstract?: boolean;
  }) {
    if (!host) return;
    try {
      const response = await run("settings", () =>
        hostClient.request("matrix.patchSettings", hostContext(host), patch, 15_000),
      );
      if (!response) return;
      if (!response.ok) {
        pushNotification(response.error.message, "error");
        return;
      }
      setMatrixStatus(response.result);
      if (patch.pollIntervalMin !== undefined) setPollText(String(response.result.pollIntervalMin));
    } catch (error) {
      pushNotification(error instanceof Error ? error.message : t("matrixSyncFailed"), "error");
    }
  }

  async function pickLibraryRoot() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, defaultPath: matrix?.libraryRoot });
      if (typeof picked !== "string" || picked === matrix?.libraryRoot) return;
      await patchSettings({ libraryRoot: picked });
    } catch (error) {
      pushNotification(
        error instanceof Error ? error.message : t("matrixPickLibraryFailed"),
        "error",
      );
    }
  }

  const loggedIn = Boolean(matrix?.loggedIn && matrix.user);
  const syncing = matrix?.sync.running === true || busy === "sync";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <SectionHeader title={t("navMatrix")} subtitle={t("matrixSubtitle")} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        <section className="mb-6">
          <h2 className="mb-2 text-sm font-medium text-muted">{t("matrixAccountGroup")}</h2>
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            {loggedIn ? (
              <>
                <p className="text-sm">
                  {t("matrixLoggedInAs", {
                    name: matrix?.user?.displayName || matrix?.user?.username || "",
                  })}
                </p>
                <p className="text-xs text-muted">
                  {t("matrixRole", {
                    role: matrix?.user?.effectiveRole || matrix?.user?.role || "",
                  })}
                </p>
                <button
                  type="button"
                  className="h-8 w-fit rounded-md border border-border px-3 text-xs hover:bg-surface-overlay"
                  disabled={busy !== null}
                  onClick={() => void logout()}
                >
                  {t("matrixLogout")}
                </button>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">{t("matrixNotLoggedIn")}</p>
                <label className="text-sm">
                  <span className="mb-1 block">{t("matrixUsername")}</span>
                  <input
                    className="h-8 w-full max-w-sm rounded-md border border-border bg-surface px-2 text-sm"
                    value={username}
                    autoComplete="username"
                    aria-label={t("matrixUsername")}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                </label>
                <label className="text-sm">
                  <span className="mb-1 block">{t("matrixPassword")}</span>
                  <input
                    type="password"
                    className="h-8 w-full max-w-sm rounded-md border border-border bg-surface px-2 text-sm"
                    value={password}
                    autoComplete="current-password"
                    aria-label={t("matrixPassword")}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
                <div className="flex items-center justify-between gap-4">
                  <span className="min-w-0 text-sm">
                    <span className="block">{t("matrixRememberPassword")}</span>
                    <span className="block text-xs text-muted">
                      {t("matrixRememberPasswordDesc")}
                    </span>
                  </span>
                  <Switch
                    checked={rememberPassword}
                    onChange={setRememberPassword}
                    label={t("matrixRememberPassword")}
                  />
                </div>
                <button
                  type="button"
                  className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md bg-accent px-3 text-xs font-medium text-accent-foreground disabled:opacity-40"
                  disabled={busy !== null || !username.trim() || !password}
                  onClick={() => void login()}
                >
                  <LogIn size={14} />
                  {t("matrixLogin")}
                </button>
              </>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-2 text-sm font-medium text-muted">{t("matrixSyncGroup")}</h2>
          <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 text-sm">
                <p>
                  {matrix?.lastSyncAt
                    ? t("matrixLastSync", { time: formatChinaDateTime(matrix.lastSyncAt) })
                    : t("matrixLastSyncNever")}
                </p>
                {syncing && (
                  <p className="text-xs text-muted">
                    {t("matrixProgress", {
                      done: matrix?.sync.done ?? 0,
                      total: matrix?.sync.total ?? 0,
                    })}
                    {matrix?.sync.currentTitle ? ` — ${matrix.sync.currentTitle}` : ""}
                  </p>
                )}
                {matrix?.lastError && (
                  <p className="text-xs text-danger">
                    {t("matrixLastError", { message: matrix.lastError })}
                  </p>
                )}
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs hover:bg-surface-overlay disabled:opacity-40"
                disabled={!loggedIn || busy !== null}
                onClick={() => void syncNow()}
              >
                <RefreshCw size={14} className={syncing ? "animate-spin" : ""} />
                {syncing ? t("matrixSyncing") : t("matrixSyncNow")}
              </button>
            </div>

            <div className="flex items-center justify-between gap-4">
              <label className="min-w-0 text-sm">
                <span className="block">{t("matrixLibraryRoot")}</span>
                <span className="block text-xs text-muted">{t("matrixLibraryRootDesc")}</span>
                <span className="mt-1 block truncate font-mono text-[11px] text-muted">
                  {matrix?.libraryRoot}
                </span>
              </label>
              <button
                type="button"
                className="h-8 shrink-0 rounded-md border border-border px-3 text-xs hover:bg-surface-overlay"
                onClick={() => void pickLibraryRoot()}
              >
                {t("matrixBrowse")}
              </button>
            </div>

            <label className="flex items-center justify-between gap-4 text-sm">
              <span>
                <span className="block">{t("matrixPollInterval")}</span>
                <span className="block text-xs text-muted">{t("matrixPollIntervalDesc")}</span>
              </span>
              <input
                className="h-8 w-20 rounded-md border border-border bg-surface px-2 text-right text-sm"
                value={pollText}
                inputMode="numeric"
                onChange={(event) => setPollText(event.target.value)}
                onBlur={() => {
                  const value = Number(pollText);
                  if (!Number.isInteger(value) || value < 5 || value > 1440) {
                    setPollText(String(matrix?.pollIntervalMin ?? 30));
                    return;
                  }
                  if (value !== matrix?.pollIntervalMin)
                    void patchSettings({ pollIntervalMin: value });
                }}
              />
            </label>

            <div className="flex items-center justify-between gap-4">
              <span className="min-w-0 text-sm">
                <span className="block">{t("matrixWithAbstract")}</span>
                <span className="block text-xs text-muted">{t("matrixWithAbstractDesc")}</span>
              </span>
              <Switch
                checked={matrix?.withAbstract !== false}
                onChange={(next) => void patchSettings({ withAbstract: next })}
                label={t("matrixWithAbstract")}
                disabled={busy !== null}
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
