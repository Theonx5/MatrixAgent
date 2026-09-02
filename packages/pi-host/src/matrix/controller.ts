import { createHostError, type HostError } from "@pideck/protocol";
import type { MethodHandler } from "../server.js";
import { isHostError, type MatrixService } from "./service.js";

export function createMatrixHandlers(
  getService: () => MatrixService | null,
): Partial<Record<string, MethodHandler>> {
  const requireService = (): MatrixService | { error: HostError } => {
    const service = getService();
    if (!service)
      return { error: createHostError("HOST_NOT_READY", "Matrix service is not ready") };
    return service;
  };

  const wrap = async (run: (service: MatrixService) => Promise<unknown>) => {
    const service = requireService();
    if ("error" in service) return { error: service.error };
    try {
      return { result: await run(service) };
    } catch (error) {
      if (isHostError(error)) return { error };
      return {
        error: createHostError(
          "INTERNAL_ERROR",
          error instanceof Error ? error.message : "Paper Matrix request failed",
        ),
      };
    }
  };

  return {
    "matrix.getStatus": async () => wrap((service) => Promise.resolve(service.status())),
    "matrix.getSettings": async () =>
      wrap((service) => Promise.resolve(service.settingsSnapshot())),
    "matrix.login": async (ctx) => {
      const params = ctx.params as {
        username: string;
        password: string;
        rememberPassword: boolean;
      };
      return wrap((service) =>
        service.login(params.username, params.password, params.rememberPassword),
      );
    },
    "matrix.logout": async () => wrap((service) => service.logout()),
    "matrix.syncNow": async () => wrap((service) => service.syncNow("manual")),
    "matrix.patchSettings": async (ctx) => {
      const params = ctx.params as {
        libraryRoot?: string;
        pollIntervalMin?: number;
        withAbstract?: boolean;
      };
      return wrap((service) => service.patchSettings(params));
    },
  };
}
