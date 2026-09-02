import { useState } from "react";
import { LoaderCircle, LogIn, Settings } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { Switch } from "../../components/Switch";
import { hostClient } from "../../lib/bridge/host-client";
import { hostContext } from "../../lib/bridge/host-context";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { deleteMatrixPassword, storeMatrixPassword } from "../../lib/matrix-secrets";

export function SidebarMatrixAccount({
  page,
  connectionPending,
  connectionTitle,
  hostFatal,
  hostReady,
}: {
  page: string;
  connectionPending: boolean;
  connectionTitle: string;
  hostFatal: string | null;
  hostReady: boolean;
}) {
  const t = useT();
  const host = useAppStore((s) => s.host);
  const matrix = useAppStore((s) => s.matrix);
  const setMatrixStatus = useAppStore((s) => s.setMatrixStatus);
  const openSettingsSection = useAppStore((s) => s.openSettingsSection);
  const setPage = useAppStore((s) => s.setPage);
  const pushNotification = useAppStore((s) => s.pushNotification);
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState(matrix?.user?.username ?? "");
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loggedIn = Boolean(matrix?.loggedIn && matrix.user);
  const syncing = matrix?.sync.running === true;

  async function login() {
    if (!host || busy) return;
    if (!username.trim() || !password) {
      setError(t("matrixNotLoggedIn"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await hostClient.request(
        "matrix.login",
        hostContext(host),
        { username: username.trim(), password, rememberPassword },
        30_000,
      );
      if (!response.ok) {
        setError(response.error.message || t("matrixLoginFailed"));
        return;
      }
      setMatrixStatus(response.result);
      if (rememberPassword) await storeMatrixPassword(username.trim(), password);
      else await deleteMatrixPassword(username.trim());
      setPassword("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("matrixLoginFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!host || busy) return;
    const currentUser = matrix?.user?.username;
    setBusy(true);
    try {
      const response = await hostClient.request("matrix.logout", hostContext(host), null, 15_000);
      if (!response.ok) {
        pushNotification(response.error.message, "error");
        return;
      }
      setMatrixStatus(response.result);
      if (currentUser) await deleteMatrixPassword(currentUser);
    } catch (err) {
      pushNotification(err instanceof Error ? err.message : t("matrixLoginFailed"), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shrink-0 border-t border-border p-2" data-sidebar-matrix>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => {
            if (loggedIn) openSettingsSection("matrix");
            else setOpen(true);
          }}
          className="interface-density-primary-row flex h-10 min-w-0 flex-1 items-center gap-3 rounded-md px-2.5 text-left text-sm transition-colors hover:bg-surface-overlay"
        >
          <LogIn size={17} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {loggedIn ? matrix?.user?.displayName || matrix?.user?.username : t("matrixLogin")}
          </span>
          {syncing ? <LoaderCircle size={14} className="shrink-0 animate-spin text-muted" /> : null}
        </button>
        {loggedIn ? (
          <button
            type="button"
            onClick={() => void logout()}
            className="h-8 shrink-0 rounded-md px-2 text-[11px] text-muted hover:bg-surface-overlay hover:text-foreground"
          >
            {t("matrixLogout")}
          </button>
        ) : null}
        <SettingsButton
          page={page}
          connectionPending={connectionPending}
          connectionTitle={connectionTitle}
          hostFatal={hostFatal}
          hostReady={hostReady}
          onClick={() => setPage(page === "chat" ? "settings" : "chat")}
        />
      </div>

      {open && !loggedIn ? (
        <Dialog
          title={t("matrixLogin")}
          confirmLabel={busy ? t("matrixSyncing") : t("matrixLogin")}
          onCancel={() => {
            if (!busy) setOpen(false);
          }}
          onConfirm={() => void login()}
        >
          <div className="flex flex-col gap-3 text-foreground">
            <p>{t("matrixNotLoggedIn")}</p>
            <label className="text-sm">
              <span className="mb-1 block">{t("matrixUsername")}</span>
              <input
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-foreground"
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
                className="h-8 w-full rounded-md border border-border bg-surface px-2 text-sm text-foreground"
                value={password}
                autoComplete="current-password"
                aria-label={t("matrixPassword")}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t("matrixRememberPassword")}</span>
              <Switch
                checked={rememberPassword}
                onChange={setRememberPassword}
                label={t("matrixRememberPassword")}
              />
            </div>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}

function SettingsButton({
  page,
  connectionPending,
  connectionTitle,
  hostFatal,
  hostReady,
  onClick,
}: {
  page: string;
  connectionPending: boolean;
  connectionTitle: string;
  hostFatal: string | null;
  hostReady: boolean;
  onClick: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      data-ui="nav-item"
      data-state={page !== "chat" ? "active" : "inactive"}
      aria-label={t("settingsTitle")}
      title={connectionTitle}
      className={`flex size-8 shrink-0 items-center justify-center rounded-md transition-colors ${
        page !== "chat"
          ? "theme-nav-active bg-nav-active text-nav-active-foreground"
          : "text-muted hover:bg-surface-overlay hover:text-foreground"
      }`}
    >
      {connectionPending ? (
        <LoaderCircle size={14} className="animate-spin" />
      ) : (
        <span className="relative">
          <Settings size={16} />
          <span
            className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${
              hostFatal ? "bg-danger" : hostReady ? "bg-success" : "bg-muted"
            }`}
          />
        </span>
      )}
    </button>
  );
}
