import { DocsApp } from "@iterate-com/docs";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { isIdempotencyConflict } from "iterate/processors";
import { parseCodemodeResponse } from "./codemode-format.ts";

// THE CODEMODE-TAG EXPERIMENT — this project's agents respond with markdown
// plus one embedded <codemode status="..."> tag instead of a bare ```ts
// fence, and THIS FILE is the interpreter. The platform births every agent
// with default response parsing ON and a HIGH debounce (10s); this worker
// reacts to `agent/created`, turns default parsing OFF, supersedes the
// system prompt with the codemode grammar, and lowers the debounce to the
// ordinary 250ms — the done-configuring signal, which releases a held first
// turn immediately. From then on this worker plays the part the platform's
// codemode component plays for ordinary projects:
//
//   assistant output event  → parse the tag → append script-run-requested,
//                             the prose as a chat message, the status as the
//                             live activity label (or corrective feedback)
//   script-run-settled      → append the rendered result as developer
//                             context, which drives the agent's next turn
//
// Everything happens through public stream events any project member could
// append — no platform privileges involved. The prompt teaching the grammar
// lives at prompts/agent-system-prompt.md in this repo; the parser at
// codemode-format.ts. Editing either is a commit — no platform deploy.
//
// Idempotency keys deliberately mirror the platform component's keys (the
// fixed `agent/` namespace): if this worker was slow at a birth and the
// platform's parser handled the first turn, replays dedupe against each
// other instead of double-executing scripts.
//
// KNOWN LIMITS (this is an experiment): delivery to this worker is
// observation-grade — an event this handler fails on is SKIPPED, not
// retried forever, so a dropped delivery quietly kills that turn (send a new
// message to start fresh). Slash commands (/example, /script) are platform
// interpretation and therefore inert here. Slack/Telegram/email agents keep
// default parsing untouched — the conversion below only fires for plain
// `/agents/…` web agents. If this worker is down at a birth, the agent
// answers after ~10s with the platform's fenced-ts defaults — coherent,
// just not the codemode dialect — until the next deploy's sweep converts it.

/** Assistant output events stamped by the platform's LLM component carry the
 * agent contract's slug; "agent-headless" is the retired second slug old
 * events were stamped with. */
const PLATFORM_AGENT_SLUGS = new Set(["agent", "agent-headless"]);
const SYSTEM_PROMPT_KEY = "agent/system-prompt";
const SCRIPT_EXPIRY_MS = 10 * 60_000;
const RESULT_HISTORY_LIMIT = 30_000;
/** Inline budget once the full copy is spilled — the inline copy is a map of
 * the data, not the data. */
const RESULT_SPILL_PREVIEW_CHARS = 10_000;

/** The agent's own workspace path: /workspaces + the agent stream path (the
 * platform's agentWorkspacePath convention). */
function itxWorkspacePathForAgent(agentPath: string): string {
  return `/workspaces${agentPath}`;
}

export default class ProjectWorker extends IterateWorkerEntrypoint {
  #docsApp = DocsApp.create(this.env, {
    auth: { policy: "project-member" },
    proxy: {
      origin: "https://docs.iterate.workers.dev",
      originOverrideKvKey: "docs-app-origin",
    },
  });

  /** Agent-callable app helpers: `itx.worker.docs.link({ workspace, path })`
   * mints the document view, `link({ workspace, repo, task? })` the board. */
  get docs() {
    return this.#docsApp.rpc;
  }

  // The base class delivers committed events on ANY stream here at least once
  // and in per-stream order.
  protected override async processEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "events.iterate.com/agent/created": {
        // The birth event on the agent's own stream (copies carry
        // source.copiedFrom and must not re-target the collection stream).
        if (event.source?.copiedFrom !== undefined) break;
        await this.#configureNewbornAgent(event.path);
        await this.#syncAgentsMdContext([event.path]);
        break;
      }
      case "events.iterate.com/project/worker-updated": {
        // Runs after every config deploy — including the FIRST deploy after a
        // project switches its config repo to this template wholesale. Sweep
        // every existing agent into the codemode dialect (idempotent per
        // agent, so later deploys no-op).
        if (event.path !== "/") break;
        const itx = this.itx;
        const agents = await itx.agents.list();
        await this.#convertAgents(agents.map((agent) => agent.path));
        await this.#syncSystemPromptContext(agents.map((agent) => agent.path));
        await this.#syncAgentsMdContext(agents.map((agent) => agent.path));
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        // Any config-repo commit MAY have changed the prompt — the sync's
        // read-compare step turns the ones that didn't into no-ops. THIS is
        // the iteration loop: edit prompts/agent-system-prompt.md, commit,
        // and every agent picks it up.
        if (event.path !== "/repos/config") break;
        const itx = this.itx;
        const agents = await itx.agents.list();
        await this.#syncSystemPromptContext(agents.map((agent) => agent.path));
        await this.#syncAgentsMdContext(agents.map((agent) => agent.path));
        break;
      }
      case "events.iterate.com/agents/context-added": {
        await this.#interpretAssistantResponse(event);
        break;
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        await this.#renderScriptSettlement(event);
        break;
      }
      default:
        break;
    }
  }

  /**
   * THE OPT-IN, at birth: the platform births agents with default parsing ON
   * and a high (10s) debounce — that window is exactly for this reaction.
   * ONE atomic batch turns default parsing off, supersedes the platform's
   * keyed system-prompt slot with the codemode grammar, and lowers the
   * debounce to the ordinary 250ms (LAST on purpose: done configuring —
   * releases a held first turn). Gated to plain web agents: integration
   * agents (slack/telegram/email) keep the fenced format their channel
   * prompts teach.
   */
  async #configureNewbornAgent(agentPath: string): Promise<void> {
    if (!agentPath.startsWith("/agents/")) return;
    if (/^\/agents\/(slack|telegram|email)\//.test(agentPath)) return;
    const itx = this.itx;
    const file = await itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    // A missing prompt file leaves the platform prompt AND platform parsing
    // standing — this experiment degrades to fenced-ts, never to an agent
    // taught a grammar nobody interprets.
    if (file === null) return;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.content));
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.#appendUnlessAlreadyRecorded(() =>
      itx.agents.get(agentPath).append(
        {
          type: "events.iterate.com/agent/configured",
          idempotencyKey: "codemode-tag/birth-parsing-off:v1",
          payload: { config: { interpretResponses: false } },
        },
        {
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `codemode-tag/birth-prompt:${hash}`,
          payload: {
            content: file.content,
            key: SYSTEM_PROMPT_KEY,
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
            role: "system",
          },
        },
        {
          type: "events.iterate.com/agent/configured",
          idempotencyKey: "codemode-tag/birth-debounce:v1",
          payload: { config: { llmRequestDebounceMs: 250 } },
        },
      ),
    );
  }

  /**
   * The deploy-time sweep for agents born before this worker version (or
   * while it was down): same conversion as the birth reaction, one
   * idempotency-keyed event per agent so repeats no-op. Mid-turn flips are
   * tolerated — a response generated under the fenced prompt but parsed by
   * the codemode parser gets corrective feedback and the loop recovers.
   */
  async #convertAgents(agentPaths: string[]): Promise<void> {
    const itx = this.itx;
    for (const path of agentPaths) {
      if (!path.startsWith("/agents/")) continue;
      if (/^\/agents\/(slack|telegram|email)\//.test(path)) continue;
      await this.#appendUnlessAlreadyRecorded(() =>
        itx.agents.get(path).append({
          type: "events.iterate.com/agent/configured",
          idempotencyKey: "codemode-tag/convert:v1",
          payload: {
            config: { interpretResponses: false, llmRequestDebounceMs: 250 },
          },
        }),
      );
    }
  }

  /**
   * The codemode-tag prompt supersedes the platform's keyed system-prompt
   * slot (same pattern as the AGENTS.md sync in the default template: keyed
   * system context, per-transition idempotency keys, appends only on a real
   * change, dont-trigger-request).
   */
  async #syncSystemPromptContext(agentPaths: string[]): Promise<void> {
    if (agentPaths.length === 0) return;
    const itx = this.itx;
    const file = await itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    // A deleted prompt file leaves the platform prompt standing — this
    // experiment degrades to fenced-ts prompting, never to no prompt at all.
    if (file === null) return;
    const content = file.content;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const results = await Promise.allSettled(
      agentPaths.map(async (path) => {
        const agent = itx.agents.get(path);
        const snapshot = await agent.processor.snapshot();
        // COUPLED TO THE PARSING FLAG: an agent still on default parsing
        // keeps the fenced prompt — teaching it <codemode> while the fenced
        // parser still interprets its output would break every turn. The
        // conversion sweep flips the flag; this sync follows it.
        if (snapshot.state.config.interpretResponses) return;
        const slot = snapshot.state.contextItems.findLast(
          (item) => item.payload.key === SYSTEM_PROMPT_KEY,
        );
        if (slot?.payload.content === content) return;
        await agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `codemode-tag/system-prompt:${hash}:after-${slot?.offset || 0}`,
          payload: {
            content,
            key: SYSTEM_PROMPT_KEY,
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
            role: "system",
          },
        });
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined && failed.status === "rejected") throw failed.reason;
  }

  /**
   * Standing agent context — same recipe as the default template's AGENTS.md
   * sync: keyed system context, per-transition idempotency keys, appends only
   * on a real change, dont-trigger-request, tombstone on deletion.
   */
  async #syncAgentsMdContext(agentPaths: string[]): Promise<void> {
    if (agentPaths.length === 0) return;
    const itx = this.itx;
    const file = await itx.repo.readFile({ path: "AGENTS.md" });
    const content =
      file === null
        ? "(AGENTS.md was deleted from /repos/config — no standing project notes.)"
        : `Project AGENTS.md (auto-injected from /repos/config/AGENTS.md — commit updates there to teach every agent):\n\n${file.content}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const results = await Promise.allSettled(
      agentPaths.map(async (path) => {
        const agent = itx.agents.get(path);
        const snapshot = await agent.processor.snapshot();
        const slot = snapshot.state.contextItems.findLast(
          (item) => item.payload.key === "config/agents-md",
        );
        if (slot?.payload.content === content) return;
        await agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `iterate/config/agents-md:${hash}:after-${slot?.offset || 0}`,
          payload: {
            content,
            key: "config/agents-md",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
            role: "system",
          },
        });
      }),
    );
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined && failed.status === "rejected") throw failed.reason;
  }

  /**
   * The userland twin of the platform's codemode component: parse one
   * accepted assistant output and append its consequences as ONE batch —
   * status first (the code step is born with its activity label), then the
   * prose as a chat message, then the script request. The prose message
   * carries llmRequestOffset so the platform's mirror skips it (the raw
   * assistant text is already in history).
   */
  async #interpretAssistantResponse(event: StreamEvent): Promise<void> {
    if (!event.path.startsWith("/agents/")) return;
    if (/^\/agents\/(slack|telegram|email)\//.test(event.path)) return;
    // Only interpret output the platform's LLM component produced: the stamp
    // means it authored this event for an accepted request. A raw member
    // append carries no platform stamp and must not gain an interpretation.
    if (!PLATFORM_AGENT_SLUGS.has(event.source?.processor?.slug || "")) return;
    const payload = event.payload as {
      role?: string;
      content?: string;
      llmRequestOffset?: number;
    };
    if (payload.role !== "assistant") return;
    if (typeof payload.llmRequestOffset !== "number") return;
    if (typeof payload.content !== "string") return;
    // Interpret ONLY when default parsing is off for this agent: with it on
    // (a birth this worker was too slow for), the platform's own parser owns
    // the turn — a second interpretation here would double the visible chat
    // message. One snapshot per assistant turn is cheap.
    const snapshot = await this.itx.agents.get(event.path).processor.snapshot();
    if (snapshot.state.config.interpretResponses) return;
    const outcome = parseCodemodeResponse(payload.content);
    const itx = this.itx;
    const agent = itx.agents.get(event.path);
    if (outcome.kind === "malformed" || outcome.kind === "multiple") {
      const keySuffix =
        outcome.kind === "malformed"
          ? `malformed-snippet-rejected@${event.offset}`
          : `multi-snippet-rejected@${event.offset}`;
      await this.#appendUnlessAlreadyRecorded(() =>
        agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `agent/${keySuffix}`,
          payload: {
            role: "developer",
            content: outcome.feedback,
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        }),
      );
      return;
    }
    if (outcome.kind === "none") {
      if (outcome.prose === undefined) return;
      const prose = outcome.prose;
      await this.#appendUnlessAlreadyRecorded(() =>
        agent.append({
          type: "events.iterate.com/agents/web-message-sent",
          idempotencyKey: `agent/codemode-prose@${event.offset}`,
          payload: { message: prose, llmRequestOffset: payload.llmRequestOffset },
        }),
      );
      return;
    }
    const { code, status, prose } = outcome;
    const llmRequestOffset = payload.llmRequestOffset;
    // Order matters twice over: the status precedes the script so the code
    // step is born with its activity label, and the script precedes the
    // prose so the feed groups the turn as ONE activity — an assistant
    // bubble arriving at an idle activity is a settle boundary, but arriving
    // while the extracted script runs it defers exactly like a classic
    // mid-script sendMessage.
    await this.#appendUnlessAlreadyRecorded(() =>
      agent.append(
        ...(status === undefined
          ? []
          : [
              {
                type: "events.iterate.com/agent/summary-updated" as const,
                idempotencyKey: `agent/codemode-status@${event.offset}`,
                payload: { activity: status },
              },
            ]),
        {
          type: "events.iterate.com/capability-host/script-run-requested" as const,
          idempotencyKey: `agent/script-run-requested@${event.offset}`,
          payload: {
            code,
            executionId: `agent-output:${event.offset}`,
            // Anchored to the event, never `now`: redeliveries re-append the
            // identical body and dedupe on the key.
            expiresAt: Date.parse(event.createdAt) + SCRIPT_EXPIRY_MS,
          },
        },
        ...(prose === undefined
          ? []
          : [
              {
                type: "events.iterate.com/agents/web-message-sent" as const,
                idempotencyKey: `agent/codemode-prose@${event.offset}`,
                payload: { message: prose, llmRequestOffset },
              },
            ]),
      ),
    );
  }

  /**
   * The "tool result" half of the loop: a settled execution renders back as
   * developer context with after-current-request — which is what drives the
   * agent's next turn. A script that returned undefined (and didn't throw)
   * renders nothing: returning no value is how an agent ends its turn. A
   * settlement the classic processor already rendered (the birth race)
   * dedupes on the shared key.
   */
  async #renderScriptSettlement(event: StreamEvent): Promise<void> {
    if (!event.path.startsWith("/agents/")) return;
    const payload = event.payload as {
      executionId?: string;
      settlement?: {
        status?: string;
        result?: unknown;
        error?: string;
        phase?: string;
        failureKind?: string;
        executionMayHaveOccurred?: boolean;
      };
    };
    const executionId = payload.executionId;
    const settlement = payload.settlement;
    if (executionId === undefined || settlement === undefined) return;
    if (!executionId.startsWith("agent-output:")) return;
    let content: string;
    if (settlement.status === "failed") {
      const note = settlement.executionMayHaveOccurred
        ? "The script may have partially executed; inspect state before retrying."
        : "The script did not execute.";
      content =
        `Your script failed during ${settlement.phase} (${settlement.failureKind}):\n` +
        `\`\`\`\n${truncate(settlement.error || "unknown error")}\n\`\`\`\n${note}\n` +
        `Before retrying: \`await itx.docs.typecheck({ code })\` compiles a script against this ` +
        `scope's real types, and \`await itx.docs.search({ q: "several related words" })\` finds working examples.`;
    } else {
      if (settlement.result === undefined) return;
      const isRawText = typeof settlement.result === "string";
      const text = isRawText
        ? (settlement.result as string)
        : JSON.stringify(settlement.result, null, 2);
      content = await this.#renderResult({
        agentPath: event.path,
        executionId,
        isRawText,
        text,
      });
    }
    const itx = this.itx;
    await this.#appendUnlessAlreadyRecorded(() =>
      itx.agents.get(event.path).append({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: `agent/render-script-result@${event.offset}`,
        payload: {
          role: "developer",
          content,
          actor: { type: "script", executionId },
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      }),
    );
  }

  /**
   * An oversized result SPILLS to the agent's own workspace (mirroring the
   * platform codemode component): the inline copy becomes a preview plus a
   * read-it-back recipe, and the model pages through the file with plain
   * TypeScript instead of re-running the expensive fetch. Best-effort — a
   * workspace that cannot write falls back to inline truncation.
   */
  async #renderResult(input: {
    agentPath: string;
    executionId: string;
    isRawText: boolean;
    text: string;
  }): Promise<string> {
    const { agentPath, executionId, isRawText, text } = input;
    const fence = isRawText ? "```" : "```json";
    if (text.length <= RESULT_HISTORY_LIMIT) {
      return `Your script returned:\n${fence}\n${text}\n\`\`\``;
    }
    try {
      // One file per execution, so replays overwrite idempotently. The agent
      // workspace lives at /workspaces/<agent path>; relative paths in the
      // agent's own scripts resolve there, so the recipe uses the relative
      // form.
      const relativePath = `script-results/${executionId.replace(/[^A-Za-z0-9._-]+/g, "-")}.${isRawText ? "txt" : "json"}`;
      const workspace = itxWorkspacePathForAgent(agentPath);
      const itx = this.itx;
      await itx.workspaces.get(workspace).writeFile(`${workspace}/${relativePath}`, text);
      const shown = text.slice(0, RESULT_SPILL_PREVIEW_CHARS);
      return [
        "Your script returned:",
        fence,
        shown,
        "```",
        `…truncated: showing the first ${shown.length.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} chars. The full result is saved in your workspace at ${JSON.stringify(relativePath)} — don't re-fetch; read and filter it with plain TypeScript in your next script, e.g.:`,
        "```ts",
        isRawText
          ? `const text = await itx.workspace.readFile(${JSON.stringify(relativePath)});`
          : `const data = JSON.parse(await itx.workspace.readFile(${JSON.stringify(relativePath)}));`,
        "```",
      ].join("\n");
    } catch (error) {
      console.error("[codemode-tag] failed to spill oversized script result", { error });
      return `Your script returned:\n${fence}\n${truncate(text)}\n\`\`\``;
    }
  }

  /** An idempotency conflict means another writer (a redelivery of ourselves,
   * or the classic processor during the birth race) already recorded this
   * consequence — losing that race is success. */
  async #appendUnlessAlreadyRecorded(append: () => Promise<unknown>): Promise<void> {
    try {
      await append();
    } catch (error) {
      if (!isIdempotencyConflict(error)) throw error;
    }
  }

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "docs") {
      return this.#docsApp.fetch(req);
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from the codemode-tag experiment project.</p>
              <p>Agents here respond with markdown plus one <code>&lt;codemode status="..."&gt;</code> block; worker.ts in the config repo interprets it. Edit prompts/agent-system-prompt.md or codemode-format.ts and commit to iterate on the format.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

function truncate(text: string): string {
  if (text.length <= RESULT_HISTORY_LIMIT) return text;
  return `${text.slice(0, RESULT_HISTORY_LIMIT)}\n… truncated (${text.length} chars total — return less: slice arrays, pick fields)`;
}
