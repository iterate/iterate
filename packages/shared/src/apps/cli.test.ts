import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";

import {
  formatAppCliError,
  normalizePermissiveInputArgv,
  normalizePermissiveInputValue,
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
