// library/mcp-server.test.ts — `itx.serveMcp()` against a fake `itx`: the handle's `fetch` is an MCP
// endpoint whose one tool, `itx.invoke`, evaluates the expression through `itx.cd('.').invoke(steps)`
// (recorded), with `args` appended to the terminal call; the result is JSON; a failure is an
// `isError` result, never a thrown error. Rows, not prose.
import { describe, expect, test } from "vitest";
import type { ItxExpression } from "../context/expression.ts";
import type { LibraryItx } from "./index.ts";
import { McpServerHandle } from "./mcp-server.ts";

/** A fake `itx` whose `cd('.')` handle records the steps it is asked to evaluate and answers from
 *  `answer` — a `cd` is a dispatch on the dotted surface, so it resolves like one (a promise). */
function fakeItx(answer: (steps: ItxExpression) => unknown): {
  itx: LibraryItx;
  evaluated: ItxExpression[];
} {
  const evaluated: ItxExpression[] = [];
  const itx = {
    cd: (path: string) => {
      expect(path).toBe(".");
      return Promise.resolve({
        invoke: async (steps: ItxExpression) => {
          evaluated.push(steps);
          return answer(steps);
        },
      });
    },
  } as unknown as LibraryItx;
  return { itx, evaluated };
}

/** One JSON-RPC request to the handle, as an MCP client sends it; the JSON-RPC message back (a
 *  JSON body, or one SSE `data:` frame). */
async function rpc(
  handle: McpServerHandle,
  method: string,
  params: unknown,
): Promise<{ status: number; message: any }> {
  const response = await handle.fetch(
    new Request("https://mcp.test/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await response.text();
  const data = text.startsWith("event:")
    ? (text.split("\n").find((line) => line.startsWith("data:")) ?? "").slice("data:".length)
    : text;
  return { status: response.status, message: data ? JSON.parse(data) : null };
}

const invoke = (handle: McpServerHandle, args: unknown) =>
  rpc(handle, "tools/call", { name: "itx.invoke", arguments: args });

/** The reference fake context: a kv, an append that echoes its events, a value JSON cannot carry. */
const kv = new Map<string, string>();
const answerAsContext = (steps: ItxExpression): unknown => {
  const spelled = JSON.stringify(steps);
  if (steps[0] === "kv" && Array.isArray(steps[1]) && steps[1][0] === "put") {
    kv.set(String(steps[1][1]), String(steps[1][2]));
    return { ok: true };
  }
  if (steps[0] === "kv" && Array.isArray(steps[1]) && steps[1][0] === "get")
    return kv.get(String(steps[1][1])) ?? null;
  if (Array.isArray(steps[0]) && steps[0][0] === "append")
    return steps[0].slice(1).map((event, i) => ({ offset: i + 1, ...(event as object) }));
  if (Array.isArray(steps[0]) && steps[0][0] === "whoami")
    return { projectId: "p", path: "/", secret: undefined };
  if (steps[0] === "cyclic") {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    return cycle;
  }
  // a CODED error, as the resolver throws (lib/errors.ts): the code is the machine-readable channel
  throw Object.assign(new Error(`no rewrite rule matches ${spelled} (default-deny)`), {
    code: "NO_ITX_EXPRESSION_MATCH",
  });
};

describe("itx.serveMcp() — the handle's fetch is an MCP endpoint with ONE tool", () => {
  test("initialize answers, tools/list shows itx.invoke with its input schema", async () => {
    const handle = new McpServerHandle(fakeItx(answerAsContext).itx);
    const initialized = await rpc(handle, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-server.test", version: "0" },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.message.result.serverInfo).toMatchObject({ name: "iterate-context" });
    const listed = await rpc(handle, "tools/list", {});
    expect(listed.message.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "itx.invoke",
    ]);
    const [tool] = listed.message.result.tools;
    expect(tool.inputSchema.required).toEqual(["expression"]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(["args", "expression"]);
  });

  const rows: {
    name: string;
    input: unknown;
    /** The steps `cd('.').invoke` is asked for. */
    evaluates?: ItxExpression;
    /** The JSON the tool answers with. */
    becomes?: unknown;
    /** …or the failure it reports (an `isError` result whose text contains this). */
    fails?: string;
  }[] = [
    {
      name: "a dotted string, exactly as itx parses it",
      input: { expression: "itx.kv.put('k', 'v')" },
      evaluates: ["kv", ["put", "k", "v"]],
      becomes: { ok: true },
    },
    {
      name: "the parsed form",
      input: { expression: ["itx", "kv", ["get", "k"]] },
      evaluates: ["kv", ["get", "k"]],
      becomes: "v",
    },
    {
      name: "args append to the terminal call",
      input: { expression: "itx.kv.put('k2')", args: ["v2"] },
      evaluates: ["kv", ["put", "k2", "v2"]],
      becomes: { ok: true },
    },
    {
      name: "args make a terminal name that call",
      input: { expression: "itx.kv.get", args: ["k2"] },
      evaluates: ["kv", ["get", "k2"]],
      becomes: "v2",
    },
    {
      name: "a root call: the receipts come back as JSON",
      input: { expression: "itx.append({ type: 'note', payload: { n: 1 } })" },
      evaluates: [["append", { type: "note", payload: { n: 1 } }]],
      becomes: [{ offset: 1, type: "note", payload: { n: 1 } }],
    },
    {
      name: "the JSON boundary drops what JSON cannot carry",
      input: { expression: "itx.whoami()" },
      evaluates: [["whoami"]],
      becomes: { projectId: "p", path: "/" },
    },
    {
      name: "an expression no rule matches is a tool failure led by its CODE, not a transport error",
      input: { expression: "itx.nope.run()" },
      fails: "NO_ITX_EXPRESSION_MATCH: no rewrite rule matches",
    },
    {
      name: "a value JSON refuses (a cycle) is a tool failure",
      input: { expression: "itx.cyclic" },
      fails: "circular",
    },
    {
      name: "an expression rooted elsewhere is refused",
      input: { expression: "kv.get('k')" },
      fails: "rooted at itx",
    },
    {
      name: "a string that does not parse is refused in the parser's words",
      input: { expression: "itx.kv.get(" },
      fails: "expression:",
    },
    {
      name: "a parsed form with a bad shape is refused in the parser's words",
      input: { expression: ["itx", 42] },
      fails: "expression:",
    },
  ];
  for (const row of rows)
    test(row.name, async () => {
      const { itx, evaluated } = fakeItx(answerAsContext);
      const { status, message } = await invoke(new McpServerHandle(itx), row.input);
      expect(status).toBe(200);
      const result = message.result as {
        content: { type: string; text: string }[];
        structuredContent?: { result: unknown };
        isError?: boolean;
      };
      if (row.fails !== undefined) {
        expect(result.isError, JSON.stringify(result)).toBe(true);
        expect(result.content[0].text).toContain(row.fails);
        return;
      }
      expect(result.isError, JSON.stringify(result)).toBeFalsy();
      expect(evaluated).toEqual([row.evaluates]);
      expect(JSON.parse(result.content[0].text)).toEqual(row.becomes);
      expect(result.structuredContent).toEqual({ result: row.becomes });
    });

  test("an input the schema refuses (no expression) is a JSON-RPC error, and a tool failure is a 200", async () => {
    const handle = new McpServerHandle(fakeItx(answerAsContext).itx);
    const refused = await invoke(handle, { args: [] });
    expect(refused.status).toBe(200);
    expect(refused.message.error ?? refused.message.result?.isError).toBeTruthy();
  });
});
