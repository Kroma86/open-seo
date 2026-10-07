import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSamBoxMode, leaseExpiresAt, leaseIdFor } from "./samBoxMode";

describe("getSamBoxMode", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each([
    [undefined, "off"],
    ["", "off"],
    [" \t", "off"],
    ["off", "off"],
    [" off ", "off"],
    ["on", "on"],
    [" on \n", "on"],
    ["ON", "off"],
    ["true", "off"],
    ["1", "off"],
    ["false", "off"],
  ] as const)("%j resolves to %s", (value, expected) => {
    expect(getSamBoxMode({ SAM_LOOP_GROK_BOX: value })).toBe(expected);
  });

  it("logs each distinct invalid trimmed value only once per isolate", () => {
    getSamBoxMode({ SAM_LOOP_GROK_BOX: "unexpected-box-mode" });
    getSamBoxMode({ SAM_LOOP_GROK_BOX: " unexpected-box-mode " });
    getSamBoxMode({ SAM_LOOP_GROK_BOX: "another-unexpected-box-mode" });
    getSamBoxMode({ SAM_LOOP_GROK_BOX: "another-unexpected-box-mode" });
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("does not warn for unset, empty, or supported values", () => {
    for (const value of [undefined, "", " ", "on", "off"]) {
      getSamBoxMode({ SAM_LOOP_GROK_BOX: value });
    }
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("Sam box lease timestamps", () => {
  const startedAt = "2026-10-07T13:20:00.123Z";

  it("derives the lease id from the run and millisecond start timestamp", () => {
    expect(leaseIdFor("run-1", startedAt)).toBe("run-1.1791379200123");
  });

  it("expires after 900 seconds with ISO milliseconds and Z", () => {
    expect(leaseExpiresAt(startedAt)).toBe("2026-10-07T13:35:00.123Z");
  });

  it("refuses an invalid lease timestamp", () => {
    expect(() => leaseIdFor("run-1", "invalid-date")).toThrow();
    expect(() => leaseExpiresAt("invalid-date")).toThrow();
  });
});
