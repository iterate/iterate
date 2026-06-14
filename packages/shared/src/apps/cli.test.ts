import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import {
  formatAppCliError,
  normalizePermissiveInputArgv,
  normalizePermissiveInputValue,
  normalizeRemoteRpcError,
} from "./cli.ts";

describe("formatAppCliError", () => {
  it("formats bad request issues as readable field errors", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "Input validation failed",
      data: {
        issues: [
          {
            path: ["path"],
            message: "Invalid input: expected string, received undefined",
          },
          {
            path: ["event", "payload", "count"],
            message: "Too small: expected number to be >=1",
          },
        ],
      },
    });

    expect(formatAppCliError(error)).toBe(
      [
        "Input validation failed",
        "- path: Invalid input: expected string, received undefined",
        "- event.payload.count: Too small: expected number to be >=1",
      ].join("\n"),
    );
  });

  it("keeps root-level issues readable", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "Input validation failed",
      data: {
        issues: [
          {
            code: "invalid_type",
            expected: "object",
            path: [],
            message: "Invalid input: expected object, received undefined",
          },
        ],
      },
    });

    expect(formatAppCliError(error)).toBe(
      ["Input validation failed", "- Invalid input: expected object, received undefined"].join(
        "\n",
      ),
    );
  });

  it("uses expected details when zod returns the generic invalid input message", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "Input validation failed",
      data: {
        issues: [
          {
            code: "invalid_type",
            expected: "object",
            path: [],
            message: "Invalid input",
          },
        ],
      },
    });

    expect(formatAppCliError(error)).toBe(
      ["Input validation failed", "- Expected object"].join("\n"),
    );
  });
});

describe("normalizePermissiveInputValue", () => {
  it("keeps valid json parseable", () => {
    expect(normalizePermissiveInputValue('{"event":{"type":"123"}}')).toBe(
      '{"event":{"type":"123"}}',
    );
  });

  it("accepts loose object syntax through yaml parsing", () => {
    expect(normalizePermissiveInputValue('{event: {type: "123"}}')).toBe(
      '{"event":{"type":"123"}}',
    );
  });

  it("accepts block yaml", () => {
    expect(normalizePermissiveInputValue('event:\n  type: "123"')).toBe('{"event":{"type":"123"}}');
  });

  it("leaves invalid structured input unchanged", () => {
    expect(normalizePermissiveInputValue("{event:")).toBe("{event:");
  });
});

describe("normalizeRemoteRpcError", () => {
  it("passes through a real Error with a message untouched", () => {
    const error = new ORPCError("BAD_REQUEST", {
      message: "Agent preset path must be /agents or start with /agents/.",
    });
    expect(normalizeRemoteRpcError(error, "project.agents.configurePreset")).toBe(error);
  });

  it("turns an opaque undefined rejection into an actionable error (never 'undefined thrown')", () => {
    const result = normalizeRemoteRpcError(undefined, "project.agents.configurePreset");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("project.agents.configurePreset");
    expect(result.message).toContain("Workers Observability");
    expect(result.message).not.toContain("Non-error of type");
  });

  it("surfaces code/status when the rejection carries them but no message", () => {
    const result = normalizeRemoteRpcError(
      { code: "INTERNAL_SERVER_ERROR", status: 500 },
      "project.agents.configurePreset",
    );
    expect(result.message).toContain("code INTERNAL_SERVER_ERROR");
    expect(result.message).toContain("status 500");
  });

  it("synthesizes a message for an Error whose message is blank", () => {
    const result = normalizeRemoteRpcError(new Error("   "), "x.y");
    expect(result.message).toContain("without a client-visible message");
  });
});

describe("normalizePermissiveInputArgv", () => {
  it("normalizes both split and equals forms", () => {
    const argv = [
      "node",
      "iterate-app-cli",
      "rpc",
      "append",
      "--input",
      '{event: {type: "123"}}',
      '--input=event:\n  type: "abc"',
    ];

    normalizePermissiveInputArgv(argv);

    expect(argv).toEqual([
      "node",
      "iterate-app-cli",
      "rpc",
      "append",
      "--input",
      '{"event":{"type":"123"}}',
      '--input={"event":{"type":"abc"}}',
    ]);
  });
});
