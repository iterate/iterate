import { DocsApp } from "@iterate-com/docs";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { isIdempotencyConflict } from "iterate/processors";
import { parseCodemodeResponse } from "./codemode-format.ts";

// THE CODEMODE-TAG EXPERIMENT — this project's agents respond with markdown
// plus one embedded <codemode status="..."> tag instead of a bare ```ts
// fence, and THIS FILE is the interpreter. The platform runs each agent under
// its HEADLESS processor (turn scheduling + the LLM call, no response
// interpretation — see the retarget below), and this worker plays the part
// the platform's codemode component plays for ordinary projects:
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
// fixed `agent/` namespace): if an agent is ever switched back to the classic
// processor (or raced it at birth), replays dedupe against each other instead
// of double-executing scripts.
//
// KNOWN LIMITS (this is an experiment): delivery to this worker is
// observation-grade — an event this handler fails on is SKIPPED, not
// retried forever, so a dropped delivery quietly kills that turn (send a new
// message to start fresh). Slash commands (/example, /script) are platform
// interpretation and therefore inert here. Slack/Telegram/email agents keep
// the classic processor untouched — the retarget below only fires for
// plain `/agents/…` web agents.

const HEADLESS_PROCESSOR_SLUG = "agent-headless";
const SYSTEM_PROMPT_KEY = "agent/system-prompt";
const SCRIPT_EXPIRY_MS = 10 * 60_000;
const RESULT_HISTORY_LIMIT = 30_000;

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
        await this.#handoverToHeadless([event.path]);
        await this.#syncSystemPromptContext([event.path]);
        await this.#syncAgentsMdContext([event.path]);
        break;
      }
      case "events.iterate.com/project/worker-updated": {
        // Runs after every config deploy — including the FIRST deploy after a
        // project switches its config repo to this template wholesale. Sweep
        // every existing agent onto the headless driver (idempotent per
        // agent, so later deploys no-op).
        if (event.path !== "/") break;
        const itx = await this.itx;
        const agents = await itx.agents.list();
        await this.#handoverToHeadless(agents.map((agent) => agent.path));
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
        const itx = await this.itx;
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
        // A settle is when a busy agent may have gone idle — retry the
        // deferred driver flip (no-op once flipped; see #handoverToHeadless).
        if (event.path.startsWith("/agents/")) await this.#handoverToHeadless([event.path]);
        break;
      }
      case "events.iterate.com/agent/llm-request-settled": {
        // Same idle-retry lane for turns that produced no script.
        if (event.path.startsWith("/agents/")) await this.#handoverToHeadless([event.path]);
        break;
      }
      default:
        break;
    }
  }

  /**
   * THE OPT-IN. Hosted-processor subscriptions cannot be removed, so the
   * handover to the headless processor is ADDITIVE: subscribe the
   * `agent-headless` name (a public subscription-configured append) and flip
   * the agent's `config.driver` knob — the platform guarantees exactly one
   * of the two subscribed processors acts, selected by that knob. Reversible
   * by flipping the knob back. Gated to plain web agents: integration agents
   * (slack/telegram/email) keep the fenced format their channel prompts
   * teach.
   *
   * The DRIVER FLIP WAITS FOR IDLE: flipping while a request is open would
   * make the headless processor adopt and re-dial the classic processor's
   * in-flight call (isExecuting is per-instance), and whichever settlement
   * wins, a classic-stamped assistant item would be interpreted by nobody —
   * the turn dies quietly. So a busy agent is left alone here, and the
   * settle-event retries below flip it the moment its current turn chain
   * finishes. (A message landing in the gap between the idle check and the
   * flip commit can still recreate the race — accepted as an experiment
   * caveat; closing it fully needs a platform-side adopt guard.)
   */
  async #handoverToHeadless(agentPaths: string[]): Promise<void> {
    const itx = await this.itx;
    for (const path of agentPaths) {
      if (!path.startsWith("/agents/")) continue;
      if (/^\/agents\/(slack|telegram|email)\//.test(path)) continue;
      await this.#appendUnlessAlreadyRecorded(() =>
        itx.streams.get(path).append({
          type: "events.iterate.com/stream/subscription-configured",
          idempotencyKey: `codemode-tag/handover-subscribe:${path}`,
          payload: {
            name: HEADLESS_PROCESSOR_SLUG,
            receiver: { action: "facet-processor", source: { kind: "builtin" } },
          },
        }),
      );
      const snapshot = await itx.agents.get(path).processor.snapshot();
      if (snapshot.state.config.driver === HEADLESS_PROCESSOR_SLUG) continue;
      const busy =
        snapshot.state.openRequest !== null ||
        snapshot.state.activeScriptExecutionIds.length > 0 ||
        snapshot.state.pendingLlmRequestTrigger !== null;
      if (busy) continue;
      await this.#appendUnlessAlreadyRecorded(() =>
        itx.agents.get(path).append({
          type: "events.iterate.com/agent/configured",
          idempotencyKey: `codemode-tag/handover-driver:${path}`,
          payload: { config: { driver: HEADLESS_PROCESSOR_SLUG } },
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
    const itx = await this.itx;
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
    const itx = await this.itx;
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
    // Only interpret output the HEADLESS processor produced: its stamp means
    // the LLM component authored this event for an accepted request on a
    // stream that opted in. Classic-processed output (slug "agent") was
    // already interpreted platform-side, and a raw member append carries no
    // platform stamp at all — neither may gain a second interpretation here.
    if (event.source?.processor?.slug !== HEADLESS_PROCESSOR_SLUG) return;
    const payload = event.payload as {
      role?: string;
      content?: string;
      llmRequestOffset?: number;
    };
    if (payload.role !== "assistant") return;
    if (typeof payload.llmRequestOffset !== "number") return;
    if (typeof payload.content !== "string") return;
    const outcome = parseCodemodeResponse(payload.content);
    const itx = await this.itx;
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
        ...(prose === undefined
          ? []
          : [
              {
                type: "events.iterate.com/agents/web-message-sent" as const,
                idempotencyKey: `agent/codemode-prose@${event.offset}`,
                payload: { message: prose, llmRequestOffset },
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
      content = `Your script returned:\n${isRawText ? "```" : "```json"}\n${truncate(text)}\n\`\`\``;
    }
    const itx = await this.itx;
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
