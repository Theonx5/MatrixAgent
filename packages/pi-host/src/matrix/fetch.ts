import { Agent, fetch as undiciFetch } from "undici";
import { MatrixHttpError, type MatrixFetch } from "./client.js";

let ipv4Agent: Agent | undefined;

function getIpv4Agent(): Agent {
  ipv4Agent ??= new Agent({
    connect: { family: 4, timeout: 20_000 },
    bodyTimeout: 120_000,
    headersTimeout: 60_000,
  });
  return ipv4Agent;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function collectCodes(error: unknown, depth = 0): string[] {
  if (!error || depth > 5) return [];
  const record = asRecord(error);
  if (!record) return [];
  const codes: string[] = [];
  if (typeof record.code === "string") codes.push(record.code);
  if (record.cause) codes.push(...collectCodes(record.cause, depth + 1));
  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) codes.push(...collectCodes(inner, depth + 1));
  }
  return codes;
}

function collectMessages(error: unknown, depth = 0): string[] {
  if (!error || depth > 5) return [];
  const messages: string[] = [];
  if (error instanceof Error && error.message) messages.push(error.message);
  const record = asRecord(error);
  if (!record) return messages;
  if (record.cause) messages.push(...collectMessages(record.cause, depth + 1));
  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) messages.push(...collectMessages(inner, depth + 1));
  }
  return messages;
}

export function isNetworkFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  const codes = collectCodes(error);
  if (
    codes.some((code) =>
      [
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "ECONNRESET",
        "ECONNABORTED",
        "ETIMEDOUT",
        "ENETUNREACH",
        "EHOSTUNREACH",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      ].includes(code),
    )
  ) {
    return true;
  }
  return error.message === "fetch failed";
}

export function formatFetchError(error: unknown, target: string): string {
  let host = target;
  try {
    host = new URL(target).host;
  } catch {
    /* keep raw target */
  }
  const codes = collectCodes(error);
  const messages = collectMessages(error).join(" ");
  const code = codes[0];
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return `Cannot resolve ${host} (DNS ${code}). Check the network.`;
  }
  if (code === "ECONNREFUSED") {
    return `Connection refused by ${host}.`;
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `Timed out connecting to ${host}.`;
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return `Connection to ${host} was reset. If you use a proxy, set httpProxy in settings.json.`;
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" ||
    code === "CERT_HAS_EXPIRED" ||
    /certificate|SSL|TLS/i.test(messages)
  ) {
    return `TLS certificate error connecting to ${host}${code ? ` (${code})` : ""}.`;
  }
  if (code) return `Cannot reach ${host} (${code}). Check the network or HTTP proxy.`;
  if (error instanceof Error && error.message && error.message !== "fetch failed") {
    return `Cannot reach ${host}: ${error.message}`;
  }
  return `Cannot reach ${host}. Check the network or HTTP proxy.`;
}

async function performFetch(
  input: string,
  init: Parameters<MatrixFetch>[1],
  dispatcher?: Agent,
): Promise<Awaited<ReturnType<MatrixFetch>>> {
  const headers = { "User-Agent": "MatrixAgent/0.2.3", ...(init?.headers ?? {}) };
  const response = dispatcher
    ? await undiciFetch(input, {
        method: init?.method,
        headers,
        body: init?.body,
        signal: init?.signal,
        dispatcher,
        redirect: "follow",
      })
    : await fetch(input, {
        method: init?.method,
        headers,
        body: init?.body,
        signal: init?.signal,
        redirect: "follow",
      });
  return {
    status: response.status,
    headers: response.headers,
    json: () => response.json() as Promise<unknown>,
    text: () => response.text(),
    arrayBuffer: () => response.arrayBuffer(),
  };
}

export function createMatrixFetch(): MatrixFetch {
  return async (input, init) => {
    try {
      return await performFetch(input, init);
    } catch (error) {
      if (init?.signal?.aborted) throw error;
      if (isNetworkFetchError(error)) {
        try {
          return await performFetch(input, init, getIpv4Agent());
        } catch (retryError) {
          throw new MatrixHttpError(0, formatFetchError(retryError, input));
        }
      }
      throw new MatrixHttpError(0, formatFetchError(error, input));
    }
  };
}
