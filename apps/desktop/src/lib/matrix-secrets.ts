const SERVICE = "matrix-agent";

function accountFor(username: string): string {
  return `papermatrix:${username}`;
}

export async function storeMatrixPassword(username: string, password: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("secrets_set", {
    service: SERVICE,
    account: accountFor(username),
    secret: password,
  });
}

export async function loadMatrixPassword(username: string): Promise<string | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<string | null>("secrets_get", {
      service: SERVICE,
      account: accountFor(username),
    });
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function deleteMatrixPassword(username: string): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("secrets_delete", { service: SERVICE, account: accountFor(username) });
  } catch {
    /* already gone or unsupported */
  }
}
