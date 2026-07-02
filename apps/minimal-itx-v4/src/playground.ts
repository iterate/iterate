import type { CfExecutionContext, Secret, Session } from "./types.ts";
import { TRUSTED_INTERNAL_ITX_TOKEN } from "./auth.ts";
import { UnauthenticatedItxRpcTarget } from "./rpc-targets.ts";

type PlaygroundCommandRequest = {
  action?: unknown;
  code?: unknown;
  input?: unknown;
};

const PLAYGROUND_ACTIONS = [
  "whoami",
  "create-project",
  "project-egress",
  "plain-intercept-placeholder",
  "secret-egress",
  "blind-relay-proof-command",
] as const;

export async function playgroundResponse(
  request: Request,
  ctx: CfExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/" || url.pathname === "/playground") {
    if (request.method !== "GET") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    return new Response(playgroundHtml(url.origin), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
    });
  }

  if (url.pathname === "/playground/target") {
    return playgroundTargetResponse(request);
  }

  if (url.pathname === "/playground/run") {
    if (request.method !== "POST") {
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }
    return runPlaygroundCommand(request, ctx);
  }

  return null;
}

async function runPlaygroundCommand(request: Request, ctx: CfExecutionContext): Promise<Response> {
  let input: PlaygroundCommandRequest;
  try {
    input = (await request.json()) as PlaygroundCommandRequest;
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const parsed = parsePlaygroundCommandRequest(input);
  if (parsed instanceof Response) return parsed;

  if (typeof parsed.action !== "string" || parsed.action.trim() === "") {
    return Response.json({ error: "action is required" }, { status: 400 });
  }
  if (!PLAYGROUND_ACTIONS.includes(parsed.action as (typeof PLAYGROUND_ACTIONS)[number])) {
    return Response.json(
      {
        availableActions: PLAYGROUND_ACTIONS,
        error: `unknown action: ${parsed.action}`,
        ok: false,
      },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  const session = new UnauthenticatedItxRpcTarget(new Headers(), ctx).authenticate({
    type: "trusted-internal",
    token: TRUSTED_INTERNAL_ITX_TOKEN,
  });
  const helpers = playgroundHelpers(new URL(request.url).origin);

  try {
    const result = await withTimeout(
      runPlaygroundAction(parsed.action, parsed.input, session, helpers),
      20_000,
      "command timed out after 20s",
    );
    return Response.json({
      durationMs: Date.now() - startedAt,
      ok: true,
      result: await toJsonable(result),
    });
  } catch (error) {
    return Response.json(
      {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        stack:
          booleanParam(parsed.input, "debug", false) && error instanceof Error
            ? error.stack
            : undefined,
      },
      { status: 500 },
    );
  }
}

function parsePlaygroundCommandRequest(input: PlaygroundCommandRequest):
  | {
      action: string;
      input: Record<string, unknown>;
    }
  | Response {
  if (typeof input.action === "string") {
    return { action: input.action, input: objectInput(input.input) };
  }

  if (typeof input.code === "string") {
    try {
      const codeInput = JSON.parse(input.code) as unknown;
      if (isRecord(codeInput) && typeof codeInput.action === "string") {
        return {
          action: codeInput.action,
          input: objectInput(codeInput),
        };
      }
      return Response.json(
        { error: "JSON snippet must include an action string" },
        { status: 400 },
      );
    } catch {
      return Response.json(
        {
          error:
            "Cloudflare Workers disallow eval/code generation. Use one of the JSON action snippets in the textarea.",
        },
        { status: 400 },
      );
    }
  }

  return Response.json({ error: "action is required" }, { status: 400 });
}

async function runPlaygroundAction(
  action: string,
  input: Record<string, unknown>,
  session: Session,
  helpers: ReturnType<typeof playgroundHelpers>,
): Promise<unknown> {
  switch (action) {
    case "whoami":
      return {
        principal: session.whoami(),
        projects: session.projects.list(),
      };

    case "create-project": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "demo")),
      });
      return await project.describe();
    }

    case "project-egress": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "egress")),
      });
      const targetUrl = stringParam(input, "targetUrl", helpers.targetUrl());
      const response = await project.egress.fetch(
        new Request(targetUrl, {
          body: stringParam(input, "body", "hello from project egress"),
          headers: {
            "content-type": "text/plain",
            "x-itx-demo": "plain-egress",
          },
          method: "POST",
        }),
      );

      return {
        project: await project.describe(),
        response: await helpers.responseSummary(response),
        targetUrl,
      };
    }

    case "plain-intercept-placeholder": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "intercept")),
      });
      const targetUrl = stringParam(input, "targetUrl", helpers.targetUrl());
      const secretPath = stringParam(input, "secretPath", "/secrets/playground/intercept-token");
      const secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [targetUrl] },
        material: stringParam(input, "secretMaterial", "intercept-demo-secret"),
      });
      await waitForSecretMaterial(secret);

      const intercept = await project.egress.intercept(async (request) =>
        Response.json({
          body: await request.text(),
          headers: headersToObject(request.headers),
          intercepted: true,
          note: "Plain intercept runs before secret substitution, so it sees the getSecret(...) placeholder, not material.",
          url: request.url,
        }),
      );
      try {
        const response = await project.egress.fetch(
          new Request(targetUrl, {
            body: stringParam(input, "body", "plain interceptor should see this body"),
            headers: {
              authorization: `Bearer getSecret({ path: "${secretPath}" })`,
              "content-type": "text/plain",
              "x-itx-demo": "plain-intercept-placeholder",
            },
            method: "POST",
          }),
        );

        return {
          project: await project.describe(),
          response: await helpers.responseSummary(response),
          secret: await secret.describe(),
          targetUrl,
        };
      } finally {
        await intercept.release();
      }
    }

    case "secret-egress": {
      const project = await session.projects.create({
        slug: helpers.projectSlug(stringParam(input, "prefix", "secret-egress")),
      });
      const targetUrl = stringParam(input, "targetUrl", helpers.targetUrl());
      const secretPath = stringParam(input, "secretPath", "/secrets/playground/api-token");
      const secretMaterial = stringParam(input, "secretMaterial", "demo-secret-material");
      const secret = project.secrets.get(secretPath);
      await secret.update({
        egress: { urls: [targetUrl] },
        material: secretMaterial,
      });
      await waitForSecretMaterial(secret);

      const response = await project.egress.fetch(
        new Request(targetUrl, {
          body: stringParam(
            input,
            "body",
            "the request asks for a placeholder, not raw secret material",
          ),
          headers: {
            authorization: `Bearer getSecret({ path: "${secretPath}" })`,
            "content-type": "text/plain",
            "x-itx-demo": "secret-egress",
          },
          method: "POST",
        }),
      );

      return {
        project: await project.describe(),
        response: await helpers.responseSummary(response),
        secret: await secret.describe(),
        targetUrl,
      };
    }

    case "blind-relay-proof-command":
      return {
        command: helpers.deployedBlindRelayCommand(),
        whyThisIsACommand:
          "The deployed Worker creates TLS ciphertext, but the relay side still needs a real TCP socket. This command runs the local relay/test harness against the deployed Worker.",
      };
  }
  throw new Error(`unknown playground action: ${action}`);
}

function playgroundHelpers(origin: string) {
  return {
    origin,
    targetUrl(path = "/playground/target") {
      return new URL(path, origin).toString();
    },
    projectSlug(prefix = "playground") {
      return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    },
    async responseSummary(response: Response) {
      return responseSummary(response);
    },
    deployedBlindRelayCommand() {
      return [
        `ITX_BASE_URL=${origin}`,
        "pnpm --dir apps/minimal-itx-v4 exec vitest run itx.e2e.test.ts",
        '-t "Project egress relays secret-backed HTTPS"',
      ].join(" ");
    },
  };
}

async function playgroundTargetResponse(request: Request): Promise<Response> {
  return Response.json(
    {
      body: await request.text(),
      headers: headersToObject(request.headers),
      method: request.method,
      note: "This is a simple HTTPS target hosted by the same deployed Worker for ITX playground egress calls.",
      url: request.url,
    },
    {
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}

async function toJsonable(value: unknown): Promise<unknown> {
  if (value instanceof Response) {
    return responseSummary(value);
  }
  if (value instanceof Request) {
    return {
      body: await value.clone().text(),
      headers: headersToObject(value.headers),
      method: value.method,
      url: value.url,
    };
  }
  if (value instanceof Headers) return headersToObject(value);
  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof Error) return { message: value.message, stack: value.stack };
  return value;
}

async function responseSummary(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  return {
    body,
    headers: headersToObject(response.headers),
    status: response.status,
    statusText: response.statusText,
  };
}

function headersToObject(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });
  return result;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function objectInput(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {};
}

function stringParam(input: Record<string, unknown>, key: string, fallback: string): string {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function booleanParam(input: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = input[key];
  return typeof value === "boolean" ? value : fallback;
}

async function waitForSecretMaterial(secret: Secret): Promise<void> {
  const deadline = Date.now() + 5_000;
  let lastDescription = await secret.describe();
  while (!lastDescription.hasMaterial) {
    if (Date.now() >= deadline) {
      throw new Error(
        `secret material did not become available before timeout: ${JSON.stringify(lastDescription)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    lastDescription = await secret.describe();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function playgroundHtml(origin: string): string {
  const examples = JSON.stringify(playgroundExamples(origin));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Minimal ITX v4 Playground</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.45;
    }
    body {
      margin: 0;
      background: #f6f7f9;
      color: #14171f;
    }
    main {
      max-width: 1180px;
      margin: 0 auto;
      padding: 28px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 16px;
      color: #4f5a68;
    }
    .layout {
      display: grid;
      grid-template-columns: 260px minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .panel {
      background: #fff;
      border: 1px solid #d8dde6;
      border-radius: 8px;
    }
    .presets {
      padding: 10px;
    }
    .preset {
      width: 100%;
      display: block;
      margin: 0 0 8px;
      padding: 10px;
      border: 1px solid #c9d0dc;
      border-radius: 6px;
      background: #f9fafb;
      color: #172033;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .preset.active {
      border-color: #1463ff;
      background: #eef4ff;
    }
    .editor {
      display: grid;
      grid-template-rows: auto minmax(320px, 52vh) auto minmax(180px, 32vh);
      min-width: 0;
    }
    .bar {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid #d8dde6;
    }
    .bar:last-of-type {
      border-top: 1px solid #d8dde6;
      border-bottom: 0;
    }
    button.run {
      border: 0;
      border-radius: 6px;
      background: #1463ff;
      color: white;
      padding: 9px 14px;
      font: inherit;
      cursor: pointer;
    }
    button.run:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    textarea, pre {
      margin: 0;
      border: 0;
      padding: 14px;
      resize: vertical;
      font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      background: #0f1720;
      color: #e8edf5;
      overflow: auto;
      white-space: pre-wrap;
    }
    textarea:focus {
      outline: 2px solid #1463ff;
      outline-offset: -2px;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    .meta {
      font-size: 13px;
      color: #647084;
    }
    .warning {
      border-left: 4px solid #c77d00;
      background: #fff8e8;
      padding: 10px 12px;
      margin: 18px 0;
      color: #4c3700;
    }
    @media (max-width: 780px) {
      main { padding: 18px; }
      .layout { grid-template-columns: 1fr; }
      .editor { grid-template-rows: auto 360px auto 280px; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Minimal ITX v4 Playground</h1>
    <p>Run ITX query presets against this deployed Worker. Pick a preset, edit the JSON command, then run it against the hosted ITX surface.</p>
    <p>Plain intercept sees <code>getSecret(...)</code> placeholders; blind relay only sees encrypted TLS bytes after the Worker substitutes the secret.</p>
    <div class="warning">Demo-only: anyone with this URL can create throwaway projects on this dev Worker. Do not enter real secrets.</div>
    <div class="layout">
      <aside class="panel presets" id="presets"></aside>
      <section class="panel editor">
        <div class="bar">
          <strong id="title">Snippet</strong>
          <span class="meta" id="origin">${escapeHtml(origin)}</span>
        </div>
        <textarea id="code" spellcheck="false"></textarea>
        <div class="bar">
          <span class="meta" id="status">Ready</span>
          <button class="run" id="run">Run</button>
        </div>
        <pre id="output">{}</pre>
      </section>
    </div>
  </main>
  <script>
    const examples = ${examples};
    const presets = document.querySelector("#presets");
    const code = document.querySelector("#code");
    const output = document.querySelector("#output");
    const statusEl = document.querySelector("#status");
    const title = document.querySelector("#title");
    const run = document.querySelector("#run");
    let selected = 0;

    function select(index) {
      selected = index;
      code.value = examples[index].code;
      title.textContent = examples[index].title;
      for (const [buttonIndex, button] of [...presets.querySelectorAll("button")].entries()) {
        button.classList.toggle("active", buttonIndex === index);
      }
    }

    examples.forEach((example, index) => {
      const button = document.createElement("button");
      button.className = "preset";
      button.type = "button";
      button.textContent = example.title;
      button.addEventListener("click", () => select(index));
      presets.append(button);
    });

    run.addEventListener("click", async () => {
      run.disabled = true;
      statusEl.textContent = "Running...";
      output.textContent = "";
      try {
        JSON.parse(code.value);
        const response = await fetch("/playground/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: code.value }),
        });
        const body = await response.json();
        output.textContent = JSON.stringify(body, null, 2);
        statusEl.textContent = response.ok ? "Done" : "Failed";
      } catch (error) {
        output.textContent = String(error && error.stack ? error.stack : error);
        statusEl.textContent = "Failed";
      } finally {
        run.disabled = false;
      }
    });

    select(selected);
  </script>
</body>
</html>`;
}

function playgroundExamples(origin: string) {
  return [
    {
      id: "whoami",
      title: "Who Am I",
      code: `{
  "action": "whoami"
}`,
    },
    {
      id: "create-project",
      title: "Create Project",
      code: `{
  "action": "create-project",
  "prefix": "demo"
}`,
    },
    {
      id: "project-egress",
      title: "Project Egress",
      code: `{
  "action": "project-egress",
  "targetUrl": "${origin}/playground/target",
  "body": "hello from project egress"
}`,
    },
    {
      id: "secret-egress",
      title: "Secret Egress",
      code: `{
  "action": "secret-egress",
  "targetUrl": "${origin}/playground/target",
  "secretPath": "/secrets/playground/api-token",
  "secretMaterial": "demo-secret-material",
  "body": "the request asks for a placeholder, not raw secret material"
}`,
    },
    {
      id: "plain-intercept-placeholder",
      title: "Plain Intercept Placeholder",
      code: `{
  "action": "plain-intercept-placeholder",
  "targetUrl": "${origin}/playground/target",
  "secretPath": "/secrets/playground/intercept-token",
  "secretMaterial": "intercept-demo-secret",
  "body": "plain interceptor should see this body"
}`,
    },
    {
      id: "blind-relay-proof-command",
      title: "Blind Relay Proof Command",
      code: `{
  "action": "blind-relay-proof-command"
}`,
    },
  ].map((example) => ({
    ...example,
    code: example.code.replaceAll("${origin}", origin),
  }));
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
