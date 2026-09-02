import { hostClient } from "./bridge/host-client";
import { hostContext } from "./bridge/host-context";
import { loadMatrixPassword } from "./matrix-secrets";
import { useAppStore } from "./stores/app-store";

let reloginInFlight: Promise<void> | null = null;

export async function silentMatrixRelogin(): Promise<void> {
  if (reloginInFlight) return reloginInFlight;
  reloginInFlight = (async () => {
    const { host, matrix, setMatrixStatus } = useAppStore.getState();
    if (!host || !matrix || matrix.loggedIn || !matrix.rememberPassword || !matrix.user) return;
    const password = await loadMatrixPassword(matrix.user.username);
    if (!password) return;
    const response = await hostClient.request(
      "matrix.login",
      hostContext(host),
      {
        username: matrix.user.username,
        password,
        rememberPassword: true,
      },
      30_000,
    );
    if (!response.ok) return;
    setMatrixStatus(response.result);
    if (response.result.loggedIn) {
      await hostClient
        .request("matrix.syncNow", hostContext(host), null, 10 * 60_000)
        .catch(() => undefined);
    }
  })().finally(() => {
    reloginInFlight = null;
  });
  return reloginInFlight;
}
