import { describe, it, expect } from "vitest";
import { pluckFields } from "./test-utils.js";

describe("pluckFields", () => {
  it("extracts simple fields from objects", () => {
    const users = [
      { id: 1, name: "Alice", role: "admin" },
      { id: 2, name: "Bob", role: "user" },
      { id: 3, name: "Charlie", role: "user" },
    ];

    const result = pluckFields(users, ["name", "role"], {
      joinRows: false,
      stringifyColumns: false,
    });

    expect(result).toMatchInlineSnapshot(`
      [
        [
          "Alice",
          "admin",
        ],
        [
          "Bob",
          "user",
        ],
        [
          "Charlie",
          "user",
        ],
      ]
    `);
  });

  it("extracts nested fields using dot notation", () => {
    const events = [
      { type: "message", data: { content: "hello", timestamp: 123 } },
      { type: "error", data: { content: "oops", code: 500 } },
      { type: "message", data: { content: "world", timestamp: 456 } },
    ];

    const result = pluckFields(events, ["type", "data.content"], {
      joinRows: false,
      stringifyColumns: false,
    });

    expect(result).toMatchInlineSnapshot(`
      [
        [
          "message",
          "hello",
        ],
        [
          "error",
          "oops",
        ],
        [
          "message",
          "world",
        ],
      ]
    `);
  });

  it("handles missing fields gracefully", () => {
    const data = [
      { a: 1, b: { c: 2 } },
      { a: 3 }, // missing b
      { b: { c: 4 } }, // missing a
    ];

    const result = pluckFields(data, ["a", "b.c"], { joinRows: false, stringifyColumns: false });

    expect(result).toMatchInlineSnapshot(`
      [
        [
          1,
          2,
        ],
        [
          3,
          undefined,
        ],
        [
          undefined,
          4,
        ],
      ]
    `);
  });

  it("works with arrays and complex nested structures", () => {
    const responses = [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { users: [{ name: "Alice" }, { name: "Bob" }] },
      },
      {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: { error: "Not found" },
      },
    ];

    const result = pluckFields(responses, ["status", "headers.content-type", "body.error"], {
      joinRows: false,
      stringifyColumns: false,
    });

    expect(result).toMatchInlineSnapshot(`
      [
        [
          200,
          "application/json",
          undefined,
        ],
        [
          404,
          "text/plain",
          "Not found",
        ],
      ]
    `);
  });

  it("useful for testing async events or sequences", () => {
    // Example: testing a sequence of state changes
    const stateChanges = [
      { timestamp: 100, state: "idle", metadata: { trigger: "init" } },
      { timestamp: 200, state: "loading", metadata: { trigger: "user-action" } },
      { timestamp: 300, state: "loaded", metadata: { items: 5 } },
      { timestamp: 400, state: "error", metadata: { error: "timeout" } },
    ];

    // Extract just the state transitions and triggers
    const transitions = pluckFields(stateChanges, ["state", "metadata.trigger", "metadata.error"], {
      joinRows: false,
      stringifyColumns: false,
    });

    expect(transitions).toMatchInlineSnapshot(`
      [
        [
          "idle",
          "init",
          undefined,
        ],
        [
          "loading",
          "user-action",
          undefined,
        ],
        [
          "loaded",
          undefined,
          undefined,
        ],
        [
          "error",
          undefined,
          "timeout",
        ],
      ]
    `);
  });

  it("uses the new defaults (both stringifyColumns and joinRows true)", () => {
    const events = [
      { type: "message", data: { content: "hello" } },
      { type: "error", data: { content: "oops" } },
      { type: "message", data: { content: "world" } },
    ];

    const result = pluckFields(events, ["type", "data.content"]);

    expect(result).toMatchInlineSnapshot(`
      "["message","hello"]
      ["error","oops"]
      ["message","world"]"
    `);
  });

  it("stringifyColumns option creates JSON strings for each row", () => {
    const events = [
      { type: "message", data: { content: "hello" } },
      { type: "error", data: { content: "oops" } },
      { type: "message", data: { content: "world" } },
    ];

    const result = pluckFields(events, ["type", "data.content"], {
      stringifyColumns: true,
      joinRows: false,
    });

    expect(result).toMatchInlineSnapshot(`
      [
        "["message","hello"]",
        "["error","oops"]",
        "["message","world"]",
      ]
    `);
  });

  it("joinRows option creates a single newline-separated string", () => {
    const events = [
      { type: "message", data: { content: "hello" } },
      { type: "error", data: { content: "oops" } },
      { type: "message", data: { content: "world" } },
    ];

    const result = pluckFields(events, ["type", "data.content"], {
      joinRows: true,
      stringifyColumns: false,
    });

    expect(result).toMatchInlineSnapshot(`
      "["message","hello"]
      ["error","oops"]
      ["message","world"]"
    `);
  });

  it("combining both options creates a compact string output", () => {
    const stateChanges = [
      { timestamp: 100, state: "idle" },
      { timestamp: 200, state: "loading" },
      { timestamp: 300, state: "loaded" },
      { timestamp: 400, state: "error" },
    ];

    // This creates the most compact representation
    const result = pluckFields(stateChanges, ["timestamp", "state"], {
      joinRows: true,
      stringifyColumns: true,
    });

    expect(result).toMatchInlineSnapshot(`
      "[100,"idle"]
      [200,"loading"]
      [300,"loaded"]
      [400,"error"]"
    `);

    // Useful for quick visual inspection in tests
    console.log(result);
  });

  it("compact output is great for debugging test sequences", () => {
    // Example: Testing a multi-step workflow
    const workflowSteps = [
      { step: 1, action: "initialize", result: { status: "ok", id: "abc123" } },
      { step: 2, action: "validate", result: { status: "ok", valid: true } },
      { step: 3, action: "process", result: { status: "error", message: "timeout" } },
      { step: 4, action: "rollback", result: { status: "ok", rolled_back: true } },
    ];

    // Extract key information in a compact format (using default behavior now)
    const summary = pluckFields(workflowSteps, ["step", "action", "result.status"]);

    expect(summary).toMatchInlineSnapshot(`
      "[1,"initialize","ok"]
      [2,"validate","ok"]
      [3,"process","error"]
      [4,"rollback","ok"]"
    `);
  });
});
