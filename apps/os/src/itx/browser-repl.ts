import { RpcTarget } from "capnweb";

export const DEFAULT_BROWSER_REPL_CODE = "await itx.projects.list({ limit: 5 })";

export type BrowserReplExample = {
  code: string;
  description: string;
  id: string;
  title: string;
};

export type BrowserReplEntry = {
  code: string;
  consoleOutput: string;
  output: string;
  outputLanguage: "json" | "text";
  result?: unknown;
  status: "error" | "success";
};

export function createBrowserReplScope(scope?: Record<string, unknown>): Record<string, unknown> {
  return { RpcTarget, ...scope };
}

export function browserReplExternalScopesEqual(
  first?: Record<string, unknown>,
  second?: Record<string, unknown>,
) {
  const firstKeys = Object.keys(first ?? {});
  const secondKeys = Object.keys(second ?? {});
  if (firstKeys.length !== secondKeys.length) return false;

  for (const key of firstKeys) {
    if (!Object.prototype.hasOwnProperty.call(second ?? {}, key)) return false;
    if (!Object.is(first?.[key], second?.[key])) return false;
  }

  return true;
}

// These are living examples: each one mirrors a scenario from the itx e2e
// suite (apps/os/src/itx/e2e/*), rewritten as a self-contained REPL snippet.
// They run with `itx`, `RpcTarget`, and (in a project REPL) `projectId` in
// scope. Together they tour the whole capability surface — narrowing,
// streams, the three cap kinds, auto-proxying, egress, child contexts, and
// HTTP routing — and double as copy-paste starting points.
//
// Convention: every snippet that needs a project starts from `resolveProject`
// below, so it works in both the global REPL (uses your first project) and a
// project REPL (uses the scoped one).
const RESOLVE_PROJECT = `// Use the project this REPL is scoped to, else your first project.
const page = await itx.projects.list({ limit: 1 });
const pid = typeof projectId === "string" ? projectId : page.projects[0]?.id;
if (!pid) throw new Error("Create a project first: await itx.projects.create({ slug: 'demo' })");
const project = await itx.projects.get(pid);`;

export const BROWSER_REPL_EXAMPLES: BrowserReplExample[] = [
  {
    id: "list-and-describe-project",
    title: "List projects, then narrow and describe one",
    description:
      "The starting move for everything: itx.projects.list() shows what you can reach, and itx.projects.get(id) NARROWS to a project context (Law 4 — narrowing is construction). The returned handle is the same shape as a project REPL's itx.",
    code: `
// Every project you have access to (admins see all; users see their own).
const page = await itx.projects.list({ limit: 10 });

// Narrow to one project. The result is a fresh itx handle scoped to it —
// itx.projects.get(id).streams === a project REPL's itx.streams.
const pid = typeof projectId === "string" ? projectId : page.projects[0]?.id;
if (!pid) throw new Error("Create a project first: await itx.projects.create({ slug: 'demo' })");
const project = await itx.projects.get(pid);

// describe() reports the context, its access, and its registered caps.
return await project.describe();
`.trim(),
  },
  {
    id: "append-and-read-stream",
    title: "Append to a project stream and read it back",
    description:
      "itx.streams is the project's event store. Append an event to a path, then read the path back — the same streams a project REPL, agents, and caps all share.",
    code: `
${RESOLVE_PROJECT}

// A stream is addressed by a path within the project. Appending returns the
// stored event (with its assigned offset).
const stream = project.streams.get("/repl/demo");
const appended = await stream.append({
  type: "events.iterate.repl/demo",
  payload: { note: "hello from the REPL", at: Date.now() },
});

// Read the whole path back. Streams also carry platform events, so in real
// code you'd filter by type.
const events = await stream.read();
return { appended, count: events.length };
`.trim(),
  },
  {
    id: "provide-live-capability",
    title: "Provide a live, browser-owned capability",
    description:
      "Registers a browser-owned RpcTarget as a LIVE capability on the project (session-bound — it lives only while this REPL tab is connected), then calls it straight back through the itx fallthrough as itx.answer.run().",
    code: `
${RESOLVE_PROJECT}

// A live capability is just an RpcTarget you own. Its methods run HERE, in
// the browser tab — the project calls back to you over the open session.
class AnswerCapability extends RpcTarget {
  async run() {
    alert("The answer is 42");
    return "alerted";
  }
}

// A live target makes a session-bound cap: it disappears when this tab
// disconnects; reconnect and register again to restore it. provide() is an
// alias for define() — a live stub is just another target.
await project.caps.provide({ name: "answer", target: new AnswerCapability() });

// Unknown names on the handle fall through to the registry, so the cap is
// callable as if it were built in.
return await project.answer.run();
`.trim(),
  },
  {
    id: "provide-path-call-sdk",
    title: "Provide an SDK-shaped capability (path-call)",
    description:
      "A path-call capability implements ONE method, call({ path, args }), and receives the whole dotted path as data. This is how 'use itx.slack exactly like @slack/web-api' works — the public SDK docs become the tool docs, with a ~10-line forwarder.",
    code: `
${RESOLVE_PROJECT}

// One method handles the entire method tree. itx.fakeSlack.chat.postMessage(x)
// arrives here as { path: ["chat","postMessage"], args: [x] }.
class FakeSlackSdk extends RpcTarget {
  async call({ path, args }) {
    return { method: path.join("."), args, provider: "browser-tab" };
  }
}

// invoke: "path-call" tells the registry to deliver { path, args } in one
// shot rather than replaying property access. define() with a live target
// registers a session-bound cap.
await project.caps.define({
  name: "fakeSlack",
  invoke: "path-call",
  target: new FakeSlackSdk(),
});

// Call any depth — the path is accumulated locally and sent once.
return await project.fakeSlack.chat.postMessage({ channel: "C123", text: "hi" });
`.trim(),
  },
  {
    id: "define-durable-worker-cap",
    title: "Define a durable worker capability from source",
    description:
      "define() stores source code as a DURABLE capability (a stateless dynamic worker), loaded on demand. Unlike a live target, it survives this session. Every public method on the WorkerEntrypoint is auto-proxied — add a method, call it instantly.",
    code: `
${RESOLVE_PROJECT}

// The source exports a WorkerEntrypoint. Its env.ITERATE is a project-scoped
// itx, so the cap can use streams/fetch/other caps — but never reach beyond
// its project. cacheKey must change whenever the source changes (loader
// caches by it), so we use a fresh uuid here.
await project.caps.define({
  name: "greeter",
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              hello({ name }) { return "hello, " + name; }
              add({ a, b }) { return a + b; }
            }
          \`,
        },
      },
    },
  },
});

// Both methods are callable with zero extra wiring.
return {
  greeting: await project.greeter.hello({ name: "world" }),
  sum: await project.greeter.add({ a: 2, b: 3 }),
};
`.trim(),
  },
  {
    id: "worker-cap-uses-its-own-itx",
    title: "A worker capability using its own scoped itx",
    description:
      "A durable cap gets env.ITERATE.context — its OWN itx, scoped to the project it lives in. Here a tiny todo tool writes to and reads from a project stream, proving caps compose with the rest of the platform (and can never escape their project).",
    code: `
${RESOLVE_PROJECT}

await project.caps.define({
  name: "todo",
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            const STREAM = "/repl/todos";
            const TYPE = "events.iterate.repl/todo";
            export default class extends WorkerEntrypoint {
              async add({ text }) {
                const itx = await this.env.ITERATE.context;     // the cap's own handle
                const e = await itx.streams.get(STREAM).append({ type: TYPE, payload: { text } });
                return { offset: e.offset, text };
              }
              async list() {
                const itx = await this.env.ITERATE.context;
                const events = await itx.streams.get(STREAM).read();
                return events.filter((e) => e.type === TYPE).map((e) => e.payload.text);
              }
            }
          \`,
        },
      },
    },
  },
});

await project.todo.add({ text: "ship the capability layer" });
await project.todo.add({ text: "delete the mounts" });
return await project.todo.list();
`.trim(),
  },
  {
    id: "deep-auto-proxy",
    title: "Auto-proxying: any public method/getter, any depth",
    description:
      "There is no method list anywhere. A members cap exposes a method AND a getter returning a nested RpcTarget; itx proxies the whole surface — itx.kit.echo(...) and itx.kit.math.add(...) — with no declarations.",
    code: `
${RESOLVE_PROJECT}

await project.caps.define({
  name: "kit",
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
            class Math extends RpcTarget { add({ a, b }) { return a + b; } }
            export default class extends WorkerEntrypoint {
              echo(input) { return { echoed: input }; }
              get math() { return new Math(); }   // nested surface, also proxied
            }
          \`,
        },
      },
    },
  },
});

return {
  echo: await project.kit.echo({ hi: 1 }),
  // getter -> nested RpcTarget -> method, all proxied with zero wiring:
  sum: await project.kit.math.add({ a: 2, b: 3 }),
};
`.trim(),
  },
  {
    id: "worker-to-worker",
    title: "One worker capability calling another",
    description:
      "Capabilities compose: a 'report' worker reaches an 'inventory' worker purely through its own env.ITERATE.context (itx.inventory.count(), itx.inventory.skus.priceOf(...)). Worker→worker proxying, no wiring between them.",
    code: `
${RESOLVE_PROJECT}

// Provider cap.
await project.caps.define({
  name: "inventory",
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
            class Skus extends RpcTarget { priceOf({ sku }) { return sku === "ABC" ? 42 : 0; } }
            export default class extends WorkerEntrypoint {
              count() { return 7; }
              get skus() { return new Skus(); }
            }
          \`,
        },
      },
    },
  },
});

// Consumer cap — a different dynamic worker that calls the first via itx.
await project.caps.define({
  name: "report",
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              async build({ sku }) {
                const itx = await this.env.ITERATE.context;
                const count = await itx.inventory.count();
                const price = await itx.inventory.skus.priceOf({ sku });
                return { count, price, total: count * price };
              }
            }
          \`,
        },
      },
    },
  },
});

return await project.report.build({ sku: "ABC" });
`.trim(),
  },
  {
    id: "stateful-facet-cap",
    title: "A stateful capability with its own database (facet)",
    description:
      "exportType: 'durable-object' instantiates a Durable Object as a child of the project — its own private SQLite, zero provisioning. State persists across calls and survives code upgrades. The class MUST be a named export.",
    code: `
${RESOLVE_PROJECT}

await project.caps.define({
  name: "counter",
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        entrypoint: "Counter",   // named export required for facets
        exportType: "durable-object",
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { DurableObject } from "cloudflare:workers";
            export class Counter extends DurableObject {
              async increment() {
                const n = ((await this.ctx.storage.get("n")) ?? 0) + 1;
                await this.ctx.storage.put("n", n);   // this.ctx.storage is YOURS alone
                return n;
              }
              async current() { return (await this.ctx.storage.get("n")) ?? 0; }
            }
          \`,
        },
      },
    },
  },
});

await project.counter.increment();
await project.counter.increment();
return { current: await project.counter.current() };   // 2, and it persists
`.trim(),
  },
  {
    id: "fork-child-context",
    title: "Fork a child context (a session) with its own caps",
    description:
      "itx.fork() makes a cheap, disposable child context under the project — an agent session or scratchpad. Its caps SHADOW the parent's; names it doesn't define delegate up the chain. describe() shows the merged view with provenance.",
    code: `
${RESOLVE_PROJECT}

// A cap on the project — visible to every child through the chain.
await project.caps.define({
  name: "shared",
  invoke: "path-call",
  target: new (class extends RpcTarget {
    async call({ path }) { return { from: "project", method: path.join(".") }; }
  })(),
});

// Fork a child. It's a full itx handle on a new ctx_… context.
const child = await project.fork({ name: "repl-scratch" });

// The child can shadow 'shared' with its own definition...
await child.caps.define({
  name: "shared",
  invoke: "path-call",
  target: new (class extends RpcTarget {
    async call({ path }) { return { from: "child", method: path.join(".") }; }
  })(),
});

// ...so the child sees its own, while the project still sees its own.
return {
  fromChild: await child.shared.ping(),
  caps: await child.caps.describe(),   // merged chain, child entries first
};
`.trim(),
  },
  {
    id: "egress-with-secret-substitution",
    title: "Egress with server-side secret substitution",
    description:
      "itx.fetch() routes outbound HTTP through the project's egress path. A getSecret(...) placeholder in a header is replaced with the real secret INSIDE the worker — the secret never reaches the browser. Every project ships with an example secret.",
    code: `
${RESOLVE_PROJECT}

// The placeholder is substituted server-side; this tab never sees the value.
const response = await project.fetch("https://postman-echo.com/get", {
  headers: {
    authorization: 'Bearer getSecret({ key: "example.egress_api_key" })',
  },
});
const body = await response.json();
return { status: response.status, sawSubstitutedHeader: body.headers };
`.trim(),
  },
  {
    id: "http-cap-and-share-url",
    title: "Serve a capability over HTTP + a shareable link",
    description:
      "A cap whose fetch() is exposed (meta.http.expose) gets its own hostname: {cap}--{project}.<base>. Routable ≠ public — it's admin-gated by default. caps.shareUrl() mints a signed, expiring link: 'let me show you something real quick.'",
    code: `
${RESOLVE_PROJECT}

await project.caps.define({
  name: "hello",
  meta: { http: { expose: true } },   // routable; still admin-gated
  target: {
    type: "rpc",
    worker: {
      type: "source",
      source: {
        cacheKey: crypto.randomUUID(),
        mainModule: "cap.js",
        modules: {
          "cap.js": \`
            import { WorkerEntrypoint } from "cloudflare:workers";
            export default class extends WorkerEntrypoint {
              async fetch(request) {
                const url = new URL(request.url);
                return new Response("hello from a routable cap at " + url.pathname);
              }
            }
          \`,
        },
      },
    },
  },
});

// A signed link anyone can open for the next hour (no further auth needed).
return { shareUrl: await project.caps.shareUrl({ name: "hello", path: "/demo", ttlSeconds: 3600 }) };
`.trim(),
  },
];

export async function evalBrowserReplCode(input: { code: string; itx: unknown; env?: object }) {
  return await compileBrowserReplFunction(input.code)(input.itx, input.env ?? {}, {});
}

export async function evalBrowserReplSessionCode(input: {
  code: string;
  itx: unknown;
  env?: object;
  scope: Record<string, unknown>;
}) {
  return await compileBrowserReplFunction(input.code)(input.itx, input.env ?? {}, input.scope);
}

export async function runBrowserReplEntry(input: {
  code: string;
  itx: unknown;
  env?: object;
  scope: Record<string, unknown>;
}): Promise<BrowserReplEntry> {
  const trimmedCode = input.code.trim();
  const consoleLogs: BrowserReplConsoleLog[] = [];
  const previousConsole = input.scope.console;
  input.scope.console = createBrowserReplConsole(consoleLogs);
  try {
    const result = await evalBrowserReplSessionCode({
      code: trimmedCode,
      itx: input.itx,
      env: input.env,
      scope: input.scope,
    });
    input.scope.$_ = result;
    input.scope._ = result;
    const formattedResult = formatBrowserReplResult(result);
    return {
      code: trimmedCode,
      consoleOutput: formatBrowserReplConsoleOutput(consoleLogs),
      output: formattedResult.text,
      outputLanguage: formattedResult.language,
      result,
      status: "success",
    };
  } catch (error) {
    return {
      code: trimmedCode,
      consoleOutput: formatBrowserReplConsoleOutput(consoleLogs),
      output: error instanceof Error ? (error.stack ?? error.message) : String(error),
      outputLanguage: "text",
      status: "error",
    };
  } finally {
    if (previousConsole === undefined) {
      delete input.scope.console;
    } else {
      input.scope.console = previousConsole;
    }
  }
}

export function compileBrowserReplFunction(code: string) {
  if (startsWithTopLevelDeclaration(code)) {
    return compileBrowserReplStatements(code);
  }

  const expressionSource = `return (async () => (${code}))()`;
  try {
    // oxlint-disable-next-line no-new-func -- This helper backs the explicit browser-local REPL.
    return new Function(
      "itx",
      "env",
      "scope",
      `with (scope) { ${expressionSource} }`,
    ) as ReplFunction;
  } catch {
    return compileBrowserReplStatements(code);
  }
}

type ReplFunction = (itx: unknown, env: object, scope: Record<string, unknown>) => Promise<unknown>;

const RESERVED_TOP_LEVEL_BINDINGS = new Set(["itx", "env", "scope", "console", "$_", "_"]);

function compileBrowserReplStatements(code: string) {
  const statementSource = transformTopLevelStatements(code);
  // The newlines around the user's source are load-bearing: if the snippet
  // ends in a line comment (`// ...`), an appended `; return …` on the same
  // line would be swallowed by that comment. The `\n` closes it first.
  // oxlint-disable-next-line no-new-func -- Statement-mode fallback for the explicit browser-local REPL.
  return new Function(
    "itx",
    "env",
    "scope",
    `with (scope) { return (async () => { let __replLastValue;\n${statementSource}\n; return __replLastValue })() }`,
  ) as ReplFunction;
}

function startsWithTopLevelDeclaration(code: string) {
  return /^\s*(?:async\s+function|function|class)\s+[A-Za-z_$][\w$]*/.test(code);
}

function transformTopLevelStatements(code: string) {
  const replacements: Array<{ end: number; start: number; text: string }> = [];

  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "\\") index += 1;
      else if (char === "'") state = "code";
      continue;
    }
    if (state === "double-quote") {
      if (char === "\\") index += 1;
      else if (char === '"') state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }

    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);

    if (braceDepth !== 0 || bracketDepth !== 0 || parenDepth !== 0) continue;
    if (!isTopLevelStatementBoundary(code, index)) continue;

    const replacement = readTopLevelDeclarationReplacement(code, index);
    if (!replacement) continue;

    replacements.push(replacement);
    index = replacement.end - 1;
  }

  const finalExpressionReplacement = readFinalTopLevelExpressionReplacement(code);
  if (finalExpressionReplacement) replacements.push(finalExpressionReplacement);

  let transformed = code;
  for (const replacement of replacements.toReversed()) {
    transformed =
      transformed.slice(0, replacement.start) +
      replacement.text +
      transformed.slice(replacement.end);
  }

  return transformed;
}

function readFinalTopLevelExpressionReplacement(
  code: string,
): { end: number; start: number; text: string } | null {
  const ranges = readTopLevelStatementRanges(code);
  const finalRange = ranges.at(-1);
  if (!finalRange) return null;

  const statement = code.slice(finalRange.start, finalRange.end).trim();
  if (!statement) return null;
  if (!isTopLevelExpressionStatement(statement)) return null;

  return {
    start: finalRange.start,
    end: finalRange.end,
    text: `__replLastValue = ${code.slice(finalRange.start, finalRange.end)}`,
  };
}

function readTopLevelStatementRanges(code: string) {
  const ranges: Array<{ end: number; start: number }> = [];
  let statementStart: number | null = null;
  let state:
    | "code"
    | "line-comment"
    | "block-comment"
    | "single-quote"
    | "double-quote"
    | "template" = "code";
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;

  for (let index = 0; index < code.length; index += 1) {
    const char = code[index];
    const next = code[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "single-quote") {
      if (char === "\\") index += 1;
      else if (char === "'") state = "code";
      continue;
    }
    if (state === "double-quote") {
      if (char === "\\") index += 1;
      else if (char === '"') state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") index += 1;
      else if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line-comment";
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      index += 1;
      continue;
    }
    if (char === "'") {
      state = "single-quote";
      continue;
    }
    if (char === '"') {
      state = "double-quote";
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }

    if (braceDepth === 0 && bracketDepth === 0 && parenDepth === 0) {
      if (statementStart === null && !/\s/.test(char)) statementStart = index;

      if (statementStart !== null && char === ";") {
        ranges.push({ start: statementStart, end: index });
        statementStart = null;
      } else if (
        statementStart !== null &&
        (char === "\n" || char === "\r") &&
        canEndTopLevelStatementAtLineBreak(code, statementStart, index)
      ) {
        ranges.push({ start: statementStart, end: index });
        statementStart = null;
      }
    }

    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
  }

  if (statementStart !== null) {
    const end = trimEndIndex(code);
    if (end > statementStart) ranges.push({ start: statementStart, end });
  }

  return ranges;
}

function canEndTopLevelStatementAtLineBreak(code: string, start: number, end: number) {
  const statement = code.slice(start, end).trimEnd();
  if (!statement) return false;
  if (isLineBreakContinuation(code, end)) return false;
  return !/[([{:.,=?!+\-*/%&|^~<>]$/.test(statement);
}

function isLineBreakContinuation(code: string, index: number) {
  const next = nextNonWhitespaceCharacter(code, index);
  return next !== null && LINE_BREAK_CONTINUATION_STARTS.has(next);
}

const LINE_BREAK_CONTINUATION_STARTS = new Set([
  "%",
  "&",
  "(",
  "*",
  "+",
  "-",
  ".",
  "/",
  ":",
  "<",
  "=",
  ">",
  "?",
  "[",
  "^",
  "`",
  "|",
]);

function nextNonWhitespaceCharacter(code: string, index: number) {
  for (let nextIndex = index + 1; nextIndex < code.length; nextIndex += 1) {
    const char = code[nextIndex];
    if (char && !/\s/.test(char)) return char;
  }

  return null;
}

function trimEndIndex(code: string) {
  let end = code.length;
  while (end > 0 && /\s/.test(code[end - 1] ?? "")) end -= 1;
  if (code[end - 1] === ";") end -= 1;
  while (end > 0 && /\s/.test(code[end - 1] ?? "")) end -= 1;
  return end;
}

function isTopLevelExpressionStatement(statement: string) {
  return !/^(?:async\s+function|break|class|const|continue|debugger|do|export|for|function|if|import|let|return|switch|throw|try|var|while|with)\b/.test(
    statement,
  );
}

function readTopLevelDeclarationReplacement(
  code: string,
  index: number,
): { end: number; start: number; text: string } | null {
  const source = code.slice(index);
  const variable = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(source);
  if (variable?.[1]) {
    const equalsIndex = index + variable[0].length - 1;
    return {
      start: index,
      end: equalsIndex,
      text: `__replLastValue = ${scopeAssignmentTarget(variable[1])} `,
    };
  }

  const asyncFunction = /^async\s+function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (asyncFunction?.[1]) {
    const parenIndex = index + asyncFunction[0].length - 1;
    return {
      start: index,
      end: parenIndex,
      text: `__replLastValue = ${scopeAssignmentTarget(asyncFunction[1])} = async function ${asyncFunction[1]}`,
    };
  }

  const namedFunction = /^function\s+([A-Za-z_$][\w$]*)\s*\(/.exec(source);
  if (namedFunction?.[1]) {
    const parenIndex = index + namedFunction[0].length - 1;
    return {
      start: index,
      end: parenIndex,
      text: `__replLastValue = ${scopeAssignmentTarget(namedFunction[1])} = function ${namedFunction[1]}`,
    };
  }

  const namedClass = /^class\s+([A-Za-z_$][\w$]*)\b/.exec(source);
  if (namedClass?.[1]) {
    return {
      start: index,
      end: index + namedClass[0].length,
      text: `__replLastValue = ${scopeAssignmentTarget(namedClass[1])} = class ${namedClass[1]}`,
    };
  }

  return null;
}

function isTopLevelStatementBoundary(code: string, index: number) {
  if (!isIdentifierStart(code[index] ?? "")) return false;

  let previous = index - 1;
  let crossedLineBreak = false;
  while (previous >= 0 && /\s/.test(code[previous] ?? "")) {
    crossedLineBreak ||= code[previous] === "\n" || code[previous] === "\r";
    previous -= 1;
  }
  if (previous < 0) return true;
  if (crossedLineBreak) return true;

  return [";", "}"].includes(code[previous] ?? "");
}

function isIdentifierStart(value: string) {
  return /^[A-Za-z_$]$/.test(value);
}

function scopeAssignmentTarget(name: string) {
  if (RESERVED_TOP_LEVEL_BINDINGS.has(name)) {
    throw new Error(`REPL binding ${JSON.stringify(name)} is reserved.`);
  }

  return `scope.${name}`;
}

export function formatBrowserReplResult(result: unknown): {
  language: "json" | "text";
  text: string;
} {
  if (result === undefined) return { language: "text", text: "undefined" };
  if (typeof result === "string") return { language: "text", text: result };
  if (typeof result === "function") return { language: "text", text: String(result) };
  try {
    const json = JSON.stringify(result, null, 2);
    if (json !== undefined) return { language: "json", text: json };
    return { language: "text", text: String(result) };
  } catch {
    return { language: "text", text: String(result) };
  }
}

type BrowserReplConsoleLog = {
  args: unknown[];
  method: BrowserReplConsoleMethod;
};

type BrowserReplConsoleMethod = "debug" | "error" | "info" | "log" | "table" | "warn";

function createBrowserReplConsole(logs: BrowserReplConsoleLog[]) {
  const capturedMethods = new Map<BrowserReplConsoleMethod, (...args: unknown[]) => void>();
  const capture = (method: BrowserReplConsoleMethod) => {
    return (...args: unknown[]) => {
      logs.push({ args, method });
    };
  };

  for (const method of BROWSER_REPL_CONSOLE_METHODS) {
    capturedMethods.set(method, capture(method));
  }

  return new Proxy(globalThis.console, {
    get(consoleTarget, key, receiver) {
      if (typeof key === "string" && isBrowserReplConsoleMethod(key)) {
        return capturedMethods.get(key);
      }

      const value = Reflect.get(consoleTarget, key, receiver);
      if (typeof value === "function") return value.bind(consoleTarget);
      return value;
    },
  });
}

const BROWSER_REPL_CONSOLE_METHODS = ["debug", "error", "info", "log", "table", "warn"] as const;

function isBrowserReplConsoleMethod(value: string): value is BrowserReplConsoleMethod {
  return BROWSER_REPL_CONSOLE_METHODS.includes(value as BrowserReplConsoleMethod);
}

function formatBrowserReplConsoleOutput(logs: BrowserReplConsoleLog[]) {
  return logs
    .map((log) => {
      const prefix = log.method === "log" ? "" : `${log.method}: `;
      return `${prefix}${log.args.map(formatBrowserReplConsoleArg).join(" ")}`;
    })
    .join("\n");
}

function formatBrowserReplConsoleArg(arg: unknown) {
  return formatBrowserReplResult(arg).text;
}
