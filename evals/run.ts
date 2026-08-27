import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";

import { existsSync } from "node:fs";
import dedent from "dedent";
import { createCli } from "trpc-cli";
import { cloudflareWorkerVersionOverrideHeaders } from "@iterate-com/shared/test-support/cloudflare-worker-version-overrides";
import { connectItxReady } from "iterate/node";
import { readDevServerInfo } from "../apps/os/scripts/lib/dev-server-info.ts";

export async function list() {
  const list = await fs.readdir(import.meta.dirname);
  return list.filter((item) => existsSync(path.join(import.meta.dirname, item, "eval.md")));
}

type AuditOptions = {
  /** OS base URL. Defaults to APP_CONFIG_BASE_URL or this worktree's live dev server. */
  baseUrl?: string;
};

/** Report every agent stream and aggregate model usage for one eval project. */
export async function audit(project: string, options?: AuditOptions) {
  const projectReference = project.trim();
  if (!projectReference) throw new Error("Project slug or id is required.");

  const baseUrl =
    options?.baseUrl ||
    process.env.APP_CONFIG_BASE_URL?.trim() ||
    readDevServerInfo(path.join(import.meta.dirname, "..", "apps", "os"), {
      requireLive: true,
    })?.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error(
      "No base URL: pass --base-url, set APP_CONFIG_BASE_URL, or start the local dev server.",
    );
  }
  const secret = process.env.APP_CONFIG_ADMIN_API_SECRET?.trim() || "";
  if (!secret) throw new Error("APP_CONFIG_ADMIN_API_SECRET is required.");

  using root = await connectItxReady({
    auth: { type: "admin-secret", secret },
    baseUrl,
    headers: cloudflareWorkerVersionOverrideHeaders(process.env),
  });
  using projectItx = root.projects.get(projectReference);
  const [identity, agents] = await Promise.all([projectItx.identity(), projectItx.agents.list()]);
  const agentStreams = await Promise.all(
    agents.map(async (agent) => {
      const snapshot = await projectItx.agents.get(agent.path).processor.snapshot();
      const usage = snapshot.state.tokenUsage;
      return {
        createdAt: agent.createdAt,
        inputTokens: usage.totalInputTokens,
        outputTokens: usage.totalOutputTokens,
        cachedInputTokens: usage.totalCachedInputTokens,
        reasoningOutputTokens: usage.totalReasoningOutputTokens,
        path: agent.path,
        title: agent.title || null,
        totalTokens: usage.totalInputTokens + usage.totalOutputTokens,
      };
    }),
  );
  const totals = agentStreams.reduce(
    (sum, stream) => ({
      cachedInputTokens: sum.cachedInputTokens + stream.cachedInputTokens,
      inputTokens: sum.inputTokens + stream.inputTokens,
      outputTokens: sum.outputTokens + stream.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + stream.reasoningOutputTokens,
      totalTokens: sum.totalTokens + stream.totalTokens,
    }),
    {
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
  );

  return { project: identity, agentStreams, totals };
}

export default async function run(
  slug: string,
  options?: { agent?: string; environment?: string },
) {
  const evalFile = path.join(import.meta.dirname, slug, "eval.md");
  const agent = options?.agent || "codex";
  const environment = options?.environment || "production";
  if (agent !== "codex") throw new Error(`Agent ${agent} not supported yet`);

  await fs.access(evalFile);

  const runDir = path.join(import.meta.dirname, "runs.ignoreme", slug, Date.now().toString());
  const resultFile = path.join(runDir, "result.md");
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(resultFile, "");

  const instructions = dedent`
    Run the following eval against Iterate in the ${environment} environment.

    When finished, write the result to ${resultFile}. The first line should be either \`<result>success</result>\` or \`<result>failure</result>\`. In either case, write a concise explanation of why you think the result is what it is. If more details, logs, or notes are needed, write them freely to other files in ${runDir} and point to them in ${resultFile}.

    Create a fresh project using the default template unless the eval says otherwise.

    The eval may link to one or more real streams. Inspect them to understand what happened and to source realistic external-system responses. The product evolves constantly, so the latest agent may make requests that do not exactly match historical calls. Use the stream evidence and your judgment to return coherent responses to whatever it asks now.

    Referenced streams are read-only evidence. Read their journaled events; never invoke the referenced project's integrations or spend its secrets — that hits real external services and can trip production egress approvals, paging a human. Anything you invoke live belongs in the fresh eval project, behind your broker.

    When an eval needs an unavailable external integration, create a live capability backed by a request/response broker. Do not hard-code a narrow response table, spawn another Codex session, fork yourself, or call itx.ai.run to decide what the integration should return.

    Each capability invocation must:

    1. Emit a uniquely identified request to a process controlled by this main Codex session.
    2. Pause until this same session supplies the response.
    3. Return that response to the product agent.

    Run the product-agent request asynchronously so capability requests yield back to this same main Codex session. Use your full eval context—including referenced historical streams—to construct realistic, coherent responses. Maintain state across calls, support concurrent requests, log every exchange, use bounded timeouts, and keep the live capability connected until the product agent finishes.

    Include in ${resultFile} every agent stream created in the eval project and the total token usage. You can write helper tools in the \`evals/\` directory. Track a helper in git only if it will help future evals; otherwise give it a gitignored filename.

    Once you know the eval project's slug or id, collect this accounting with \`doppler run --project os --config <config> -- pnpm eval audit <slug-or-id>\`. It reports every agent stream plus per-stream and project-wide token usage.

    Also include the coding agent session id in the result so it can be resumed later.

    If there are links to agent chats that are relevant, include a command like \`cd apps/os && doppler run --config prd -- pnpm cli session create --project prj_... --return-to /projects/eval-.../agents/streams/agents/... --open\` to make them easy to inspect after the run.

    The eval must state its success criteria. If it does not, immediately mark the run as a failure and recommend suitable criteria in the explanation.

    This session is not a conversation and will usually run headlessly. Do not respond to the eval or ask for clarification. If the user intervenes, treat that as evidence that the eval setup may need improvement. After the eval, make any broadly useful harness or helper improvements and open a pull request.

    A valid failure can be that you lack enough access to investigate or that the eval is unclear.

    Here is the eval: ${evalFile}

    Begin.
  `;

  const instructionsFile = path.join(runDir, "instructions.md");
  await fs.writeFile(instructionsFile, instructions);

  const instructionsHandle = await fs.open(instructionsFile, "r");
  try {
    const child = spawn("codex", ["exec", "-"], {
      cwd: path.join(import.meta.dirname, ".."),
      stdio: [instructionsHandle.fd, "inherit", "inherit"],
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => resolve(code === null ? 1 : code));
    });
    if (exitCode !== 0) throw new Error(`Codex exited with code ${exitCode}`);
  } finally {
    await instructionsHandle.close();
  }

  return await fs.readFile(resultFile, "utf8");
}

void createCli(import.meta).run();
