import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import dedent from "dedent";
import { createCli } from "trpc-cli";

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
      child.on("close", (code) => resolve(typeof code === "number" ? code : 1));
    });
    if (exitCode !== 0) throw new Error(`Codex exited with code ${exitCode}`);
  } finally {
    await instructionsHandle.close();
  }

  return await fs.readFile(resultFile, "utf8");
}

void createCli(import.meta).run();
