import { DocsApp } from "@iterate-com/docs";
import {
  IterateWorkerEntrypoint,
  type AgentBirthDefaultsValue,
  type StreamEvent,
} from "iterate/sdk";
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
        // Agents are normally BORN converted (the birth defaults below);
        // these syncs only matter for agents created in the window before the
        // defaults event existed, and no-op otherwise.
        await this.#handoverToHeadless([event.path]);
        await this.#syncSystemPromptContext([event.path]);
        await this.#syncAgentsMdContext([event.path]);
        break;
      }
      case "events.iterate.com/project/worker-updated": {
        // Runs after every config deploy — including the FIRST deploy after a
        // project switches its config repo to this template wholesale.
        // Publish the birth defaults (so NEW agents are BORN headless with
        // the codemode prompt — no race), then sweep every existing agent
        // (idempotent per agent, so later deploys no-op).
        if (event.path !== "/") break;
        await this.#publishAgentBirthDefaults();
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
        // deferred driver flip, and sync the prompt right behind it (the
        // prompt sync is gated on the flipped driver, so ordering is safe).
        if (event.path.startsWith("/agents/")) {
          await this.#handoverToHeadless([event.path]);
          await this.#syncSystemPromptContext([event.path]);
        }
        break;
      }
      case "events.iterate.com/agent/llm-request-settled": {
        // Same idle-retry lane for turns that produced no script.
        if (event.path.startsWith("/agents/")) {
          await this.#handoverToHeadless([event.path]);
          await this.#syncSystemPromptContext([event.path]);
        }
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
   * THE OPT-IN, made constitutive: the platform's generic agent-creation
   * door reads the "agents/birth-defaults" key of the project's generic
   * defaults store (`project/defaults-configured`, latest occurrence wins
   * per key) and folds it into every birth batch — so new agents are BORN
   * under the headless driver with the codemode prompt and subscription,
   * and there is no first-turn race at all. Content-hash keyed: editing the
   * prompt file and committing re-publishes, and the newest event wins at
   * read.
   */
  async #publishAgentBirthDefaults(): Promise<void> {
    const itx = await this.itx;
    const file = await itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    if (file === null) return;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.content));
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.#appendUnlessAlreadyRecorded(() =>
      itx.streams.get("/").append({
        type: "events.iterate.com/project/defaults-configured",
        // New prefix on purpose: the stream rejects same-key-different-body
        // appends, so the generic event must not reuse the legacy
        // `codemode-tag/agent-birth-defaults:` keys.
        idempotencyKey: `codemode-tag/defaults:agents/birth-defaults:${hash}`,
        // Plain birth events — the creation door validates each against the
        // agent vocabulary when it reads this key and mints per-event
        // content-hash keys, so this list needs no keys of its own. The
        // prompt-slot event replaces the platform's fallback prompt in the
        // same keyed slot.
        payload: {
          key: "agents/birth-defaults",
          value: {
            birthEvents: [
              {
                type: "events.iterate.com/agent/configured",
                payload: { config: { driver: HEADLESS_PROCESSOR_SLUG } },
              },
              {
                type: "events.iterate.com/agents/context-added",
                payload: { role: "system", key: SYSTEM_PROMPT_KEY, content: file.content },
              },
              {
                type: "events.iterate.com/stream/subscription-configured",
                payload: {
                  name: HEADLESS_PROCESSOR_SLUG,
                  receiver: { action: "facet-processor", source: { kind: "builtin" } },
                },
              },
            ],
          } satisfies AgentBirthDefaultsValue,
        },
      }),
    );
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
        // COUPLED TO THE DRIVER FLIP: an agent still driven by the classic
        // processor keeps the fenced prompt — teaching it <codemode> while
        // the fenced parser still interprets its output would break every
        // turn until the deferred flip lands. The settle-event retry lane
        // calls this again right after the flip, so the prompt follows it.
        if (snapshot.state.config.driver !== HEADLESS_PROCESSOR_SLUG) return;
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
      const itx = await this.itx;
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
