import { describe, expect, it } from "vitest";
import { formatFetchError, isNetworkFetchError } from "./fetch.js";

describe("formatFetchError", () => {
  it("maps DNS failures to a host-specific message", () => {
    const error = Object.assign(new TypeError("fetch failed"), { code: "ENOTFOUND" });
    expect(formatFetchError(error, "https://papermatrix.online/api/auth/login")).toContain(
      "papermatrix.online",
    );
    expect(formatFetchError(error, "https://papermatrix.online/api/auth/login")).toContain("DNS");
  });

  it("treats Node fetch failed TypeErrors as network errors", () => {
    expect(isNetworkFetchError(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkFetchError(new Error("nope"))).toBe(false);
  });
});
