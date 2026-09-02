/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdleMatrixStatus } from "@pideck/protocol";
import { useAppStore } from "../../lib/stores/app-store";
import { hostClient } from "../../lib/bridge/host-client";
import { MatrixSettings } from "./MatrixSettings";

const HOST = {
  protocolVersion: 1 as const,
  hostInstanceId: "11111111-1111-4111-8111-111111111111",
  workspaceId: null,
  workspaceRevision: 0,
  sessionId: null,
  sessionRevision: 0,
  packageRevision: 0,
  sdkVersion: "0.84.4",
  nodeVersion: "v22",
  agentDir: "/agent",
  phase: "ready" as const,
  capabilities: {
    packageUpdateCheck: false,
    extensionUi: true as const,
    sessionExport: true,
  },
  modelConfigHealth: { state: "ok" as const, source: "ModelRegistry.getError" as const },
};

describe("MatrixSettings", () => {
  beforeEach(() => {
    useAppStore.getState().setHost(HOST);
    useAppStore.getState().setMatrixStatus(createIdleMatrixStatus("/agent/pideck/library"));
    useAppStore.getState().clearNotifications();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("logs in through the Host and stores the returned status", async () => {
    const user = userEvent.setup();
    const request = vi.spyOn(hostClient, "request").mockResolvedValue({
      ok: true,
      result: {
        ...createIdleMatrixStatus("/agent/pideck/library"),
        loggedIn: true,
        user: {
          id: "u1",
          username: "alice",
          displayName: "Alice",
          role: "paid",
          effectiveRole: "paid",
        },
      },
    } as never);

    render(<MatrixSettings />);
    expect(screen.getByText("Log in to sync your Paper Matrix library.")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Username"), "alice");
    await user.type(screen.getByLabelText("Password"), "secret");
    await user.click(screen.getByRole("button", { name: "Log in" }));

    expect(request).toHaveBeenCalledWith(
      "matrix.login",
      expect.objectContaining({ expectedHostInstanceId: HOST.hostInstanceId }),
      { username: "alice", password: "secret", rememberPassword: false },
      30_000,
    );
    expect(useAppStore.getState().matrix?.user?.username).toBe("alice");
  });
});
