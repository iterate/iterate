// Intent: codemode. A whole PROGRAM is run against the context. The script is an
// `async (itx) => …` function; it runs in a freshly-loaded isolate, is handed an
// itx it can invoke and provide against, and returns a value. The run is bracketed
// by durable script-execution-requested / -completed events.
//
//   npm run dev
//   node --experimental-strip-types steps/12-codemode/intent.test.ts

import { withItx } from "../../client.ts";

const BASE = process.env.ITX_BASE ?? "http://127.0.0.1:8787";
const CTX = `step12-${Date.now()}`;

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function main() {
  using itx = withItx<any>({ baseUrl: BASE, context: CTX });

  // A capability the script will call.
  await itx.provideCapability({
    path: ["greeter"],
    capability: (async (n: string) => `hi ${n}`) as any,
    instructions: "greet someone by name",
  });

  // The PROGRAM: it invokes an existing cap AND provides a new one, then returns.
  const code = `async (itx) => {
    const greeting = await itx.invokeCapability(["greeter"], ["from-the-script"]);
    await itx.provideCapability({ path: ["scriptMade"], capability: async () => "made inside the script" });
    return greeting;
  }`;

  const result = await itx.runScript(code);
  check(
    "a loaded script ran and invoked a capability via its itx",
    result === "hi from-the-script",
    `runScript(...) -> ${JSON.stringify(result)}`,
  );

  const names = (await itx.describe()).capabilities.map((c: any) => c.path.join("."));
  check(
    "the script provided a new capability into the context",
    names.includes("scriptMade"),
    `caps now: ${JSON.stringify(names)}`,
  );

  console.log(`\n${failures === 0 ? "step 12 intent OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("intent test crashed:", e);
  process.exit(1);
});
