import { Download } from "lucide-react";
import { Dialog } from "../../components/Dialog";
import { useT } from "../../lib/i18n/use-t";
import { useAppStore } from "../../lib/stores/app-store";
import type { AppUpdate } from "../../lib/updater";

export function AppUpdatePrompt() {
  const t = useT();
  const phase = useAppStore((state) => state.appUpdatePhase);
  const setPhase = useAppStore((state) => state.setAppUpdatePhase);
  const pushNotification = useAppStore((state) => state.pushNotification);

  if (
    phase.state !== "available" &&
    phase.state !== "downloading" &&
    phase.state !== "installing"
  ) {
    return null;
  }

  const update = phase.update;
  const busy = phase.state === "downloading" || phase.state === "installing";
  const percent =
    phase.state === "installing"
      ? 100
      : phase.state === "downloading" && phase.totalBytes && phase.totalBytes > 0
        ? Math.min(100, Math.round((phase.downloadedBytes / phase.totalBytes) * 100))
        : null;

  async function install(next: AppUpdate) {
    setPhase({
      state: "downloading",
      update: next,
      downloadedBytes: 0,
      totalBytes: null,
    });
    try {
      await next.install((progress) => {
        setPhase(
          progress.phase === "installing"
            ? { state: "installing", update: next }
            : {
                state: "downloading",
                update: next,
                downloadedBytes: progress.downloadedBytes,
                totalBytes: progress.totalBytes,
              },
        );
      });
    } catch (error) {
      setPhase({ state: "available", update: next });
      pushNotification(
        error instanceof Error
          ? `${t("notifUpdateInstallFailed")}: ${error.message}`
          : t("notifUpdateInstallFailed"),
        "error",
      );
    }
  }

  return (
    <Dialog
      title={t("updateDialogTitle", { version: update.version })}
      confirmLabel={busy ? t("hostUpdateInstalling") : t("updateDialogConfirm")}
      icon={Download}
      showCancel={!busy}
      onCancel={() => {
        if (!busy) setPhase({ state: "idle" });
      }}
      onConfirm={() => {
        if (!busy) void install(update);
      }}
    >
      {busy ? (
        <p>
          {percent === null
            ? t("updateDialogProgress", { version: update.version })
            : t("hostUpdateProgress", { percent })}
        </p>
      ) : (
        <>
          <p>{t("updateDialogBody")}</p>
          {update.notes ? (
            <p className="mt-2 whitespace-pre-wrap text-muted">{update.notes}</p>
          ) : null}
        </>
      )}
    </Dialog>
  );
}
