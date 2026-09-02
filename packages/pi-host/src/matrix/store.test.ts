import { describe, expect, it } from "vitest";
import { mapPaperMatrixUser } from "./store.js";

describe("mapPaperMatrixUser", () => {
  it("accepts Paper Matrix login users with extra fields and a null display name", () => {
    expect(
      mapPaperMatrixUser({
        id: "3f2a0000-0000-4000-8000-000000000001",
        username: "alice",
        display_name: null,
        role: "paid",
        effective_role: "paid",
        paid_until: null,
        is_active: true,
        created_at: "2026-01-01T00:00:00+00:00",
      }),
    ).toEqual({
      id: "3f2a0000-0000-4000-8000-000000000001",
      username: "alice",
      displayName: "alice",
      role: "paid",
      effectiveRole: "paid",
    });
  });
});
