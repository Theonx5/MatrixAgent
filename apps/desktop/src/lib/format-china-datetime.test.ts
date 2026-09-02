import { describe, expect, it } from "vitest";
import { formatChinaDateTime } from "./format-china-datetime";

describe("formatChinaDateTime", () => {
  it("formats UTC timestamps in Asia/Shanghai", () => {
    expect(formatChinaDateTime("2026-09-01T14:26:31.413Z")).toBe("2026-09-01 22:26:31");
  });
});
