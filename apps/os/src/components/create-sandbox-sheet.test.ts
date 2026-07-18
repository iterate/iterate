import { describe, expect, it } from "vitest";
import {
  parseSandboxCreateForm,
  shouldApplySandboxSheetOpenChange,
} from "~/lib/sandbox-create-form.ts";

describe("shouldApplySandboxSheetOpenChange", () => {
  it("rejects dismissal while a create request is pending", () => {
    expect(shouldApplySandboxSheetOpenChange(false, true)).toBe(false);
  });

  it("allows idle dismissal and open requests", () => {
    expect(shouldApplySandboxSheetOpenChange(false, false)).toBe(true);
    expect(shouldApplySandboxSheetOpenChange(true, true)).toBe(true);
  });
});

describe("parseSandboxCreateForm", () => {
  it("builds an idle-sleep sandbox create input", () => {
    expect(
      parseSandboxCreateForm({
        name: "  development  ",
        instanceType: "standard-2",
        sleepAfter: "5m",
        keepAlive: false,
      }),
    ).toEqual({
      name: "development",
      instanceType: "standard-2",
      sleepAfter: "5m",
    });
  });

  it("omits the idle timer when keep-alive is enabled", () => {
    expect(
      parseSandboxCreateForm({
        name: "always-on",
        instanceType: "basic",
        sleepAfter: "not-used",
        keepAlive: true,
      }),
    ).toEqual({
      name: "always-on",
      instanceType: "basic",
      keepAlive: true,
    });
  });

  it("rejects nested names and invalid idle timers", () => {
    expect(() =>
      parseSandboxCreateForm({
        name: "team/development",
        instanceType: "basic",
        sleepAfter: "5m",
        keepAlive: false,
      }),
    ).toThrow("single URL-safe path segment");
    expect(() =>
      parseSandboxCreateForm({
        name: "development",
        instanceType: "basic",
        sleepAfter: "5 minutes",
        keepAlive: false,
      }),
    ).toThrow("positive number of seconds");
  });
});
