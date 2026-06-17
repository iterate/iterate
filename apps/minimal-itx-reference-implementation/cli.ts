// cli.ts — a deliberately tiny command-line ITX runner.
//
// This is not a product CLI. It exists so the runtime matrix proves the same
// code body can run from a process boundary, using the same naked Cap'n Web stub
// as any script an agent would launch from a terminal.

import { withItx } from "./client.ts";

const AsyncFunction = async function () {}.constructor as new (
  ...args: string[]
) => (itx: unknown, vars: Record<string, unknown>) => Promise<unknown>;

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error(`missing value for --${name}`);
  return value;
}

if (process.argv[2] !== "run") {
  throw new Error("usage: node --experimental-strip-types cli.ts run --code <body>");
}

const vars = JSON.parse(arg("vars", "{}")) as Record<string, unknown>;
const script = new AsyncFunction("itx", "vars", arg("code"));

using itx = withItx({
  baseUrl: arg("base-url", process.env.ITX_BASE ?? "http://127.0.0.1:8788"),
  path: arg("path", "/"),
  projectId: arg("project-id", "prj_ref"),
  token: arg("token", "alice-token"),
});

const result = await script(itx, vars);
console.log(JSON.stringify(result));
