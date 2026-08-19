import { DocsApp } from "@iterate-com/docs";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { isIdempotencyConflict } from "iterate/processors";
import { parseCodemodeResponse } from "./codemode-format.ts";

// THE CODEMODE-TAG EXPERIMENT — this project's web agents respond with
// markdown plus one embedded <codemode status="..."> tag instead of a bare
// ```ts fence, and THIS FILE is the interpreter. Like every project, this
// worker authors its agents' births (the platform creates only the agent
// core, then holds the first turn until `agent/birth-finalized`); unlike the
// default template, its web agents get the codemode prompt from this repo
// and their responses are parsed by the VENDORED parser below — the platform
// interpreter (itx...interpretResponse) is never consulted for them. That is
// the point: pinning interpretation = vendoring it.
//
//   agent/created            → default birth events + THIS repo's prompt
//                              (superseding the default prompt slot) + finalize
//   assistant context-added  → parse the tag → append script-run-requested,
//                              the prose as a chat message, the status as the
//                              live activity label (or corrective feedback)
//   script-run-settled       → append the rendered result as developer
//                              context, which drives the agent's next turn
//
// Everything happens through public stream events any project member could
// append — no platform privileges involved. The prompt teaching the grammar
// lives at prompts/agent-system-prompt.md in this repo; the parser at
// codemode-format.ts. Editing either is a commit — no platform deploy.
//
// Integration agents (slack/telegram/email), MCP sessions, and onboarding
// keep the platform-default personalities and the platform interpreter: the
// codemode grammar is a WEB experiment, and their channel prompts teach a
// different reply mechanism.
//
// Idempotency keys deliberately mirror the platform interpreter's keys (the
// fixed `agent/` namespace): replays and historical streams interpreted by
// both dedupe against each other instead of double-executing scripts.
//
// KNOWN LIMITS (this is an experiment): slash commands (/example, /script)
// are platform interpretation and therefore inert on web agents here, and
// stream errors are not transcribed into web agents' model context.

const SYSTEM_PROMPT_KEY = "agent/system-prompt";
const SCRIPT_EXPIRY_MS = 10 * 60_000;
const RESULT_HISTORY_LIMIT = 30_000;
/** Inline budget once the full copy is spilled — the inline copy is a map of
 * the data, not the data. */
const RESULT_SPILL_PREVIEW_CHARS = 10_000;
/** The platform agent processor's slug — the stamp on assistant output it
 * committed for an accepted request. */
const KEEPER_PROCESSOR_SLUG = "agent";

/** The agent's own workspace path: /workspaces + the agent stream path (the
 * platform's agentWorkspacePath convention). */
function itxWorkspacePathForAgent(agentPath: string): string {
  return `/workspaces${agentPath}`;
}

/** Web agents run the codemode experiment; everything else (integration
 * channels, MCP sessions, onboarding) keeps platform-default behavior. */
function birthKindForAgentPath(
  agentPath: string,
): "web" | "onboarding" | "mcp" | "slack" | "telegram" | "email" {
  if (agentPath === "/agents/onboarding") return "onboarding";
  if (agentPath.startsWith("/agents/mcp/")) return "mcp";
  if (agentPath.startsWith("/agents/slack/")) return "slack";
  if (agentPath.startsWith("/agents/telegram/")) return "telegram";
  if (agentPath.startsWith("/agents/email/")) return "email";
  return "web";
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
        await this.#authorAgentBirth(event.path);
        await this.#syncAgentsMdContext([event.path]);
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        // Any config-repo commit MAY have changed the prompt — the sync's
        // read-compare step turns the ones that didn't into no-ops. THIS is
        // the iteration loop: edit prompts/agent-system-prompt.md, commit,
        // and every web agent picks it up.
        if (event.path !== "/repos/config") break;
        const itx = this.itx;
        const agents = await itx.agents.list();
        await this.#syncSystemPromptContext(agents.map((agent) => agent.path));
        await this.#syncAgentsMdContext(agents.map((agent) => agent.path));
        break;
      }
      case "events.iterate.com/agents/context-added": {
        if (!event.path.startsWith("/agents/")) break;
        if (birthKindForAgentPath(event.path) === "web") {
          await this.#interpretAssistantResponse(event);
        } else {
          // Non-web agents keep classic behavior via the platform interpreter.
          await this.itx.agents.get(event.path).interpretResponse(event);
        }
        break;
      }
      case "events.iterate.com/capability-host/script-run-settled": {
        if (!event.path.startsWith("/agents/")) break;
        if (birthKindForAgentPath(event.path) === "web") {
          await this.#renderScriptSettlement(event);
        } else {
          await this.itx.agents.get(event.path).interpretResponse(event);
        }
        break;
      }
      case "events.iterate.com/capability-host/preamble-set":
      case "events.iterate.com/capability-host/preamble-removed":
      case "events.iterate.com/stream/error-occurred": {
        // Grammar-neutral transcription, delegated for the agents that keep
        // platform behavior; web agents live without it (see KNOWN LIMITS).
        if (!event.path.startsWith("/agents/")) break;
        if (birthKindForAgentPath(event.path) === "web") break;
        await this.itx.agents.get(event.path).interpretResponse(event);
        break;
      }
      default:
        break;
    }
  }

  /**
   * THE BIRTH JOB. Start from the platform defaults (prompt, model, boot
   * context — channel kinds interpolate the router-recorded facts), then for
   * WEB agents supersede the default prompt slot with this repo's codemode
   * prompt in the same batch, then finalize. Content-hash keys make
   * redelivered births converge, and a prompt edit lands via the
   * commit-completed sync below rather than re-running births.
   */
  async #authorAgentBirth(agentPath: string): Promise<void> {
    const itx = this.itx;
    const agent = itx.agents.get(agentPath);
    const kind = birthKindForAgentPath(agentPath);
    const defaults = await agent.getDefaultBirthEvents({ kind });
    const finalize = {
      type: "events.iterate.com/agent/birth-finalized" as const,
      idempotencyKey: "codemode-tag/birth-finalized:v1",
      payload: {},
    };
    if (kind !== "web") {
      await this.#appendUnlessAlreadyRecorded(() => agent.append(...defaults, finalize));
      return;
    }
    // A missing prompt file leaves the platform prompt standing — this
    // experiment degrades to fenced-ts prompting, never to no prompt at all.
    const file = await itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    const promptEvents =
      file === null
        ? []
        : [
            {
              type: "events.iterate.com/agents/context-added" as const,
              idempotencyKey: `codemode-tag/system-prompt:${await sha256Hex(file.content)}:birth`,
              payload: {
                role: "system" as const,
                key: SYSTEM_PROMPT_KEY,
                content: file.content,
              },
            },
          ];
    await this.#appendUnlessAlreadyRecorded(() =>
      agent.append(...defaults, ...promptEvents, finalize),
    );
  }

  /**
   * The codemode-tag prompt supersedes the keyed system-prompt slot on later
   * prompt edits (same pattern as the AGENTS.md sync: keyed system context,
   * per-transition idempotency keys, appends only on a real change,
   * dont-trigger-request). Web agents only — everyone else keeps the
   * platform personality.
   */
  async #syncSystemPromptContext(agentPaths: string[]): Promise<void> {
    const webAgentPaths = agentPaths.filter((path) => birthKindForAgentPath(path) === "web");
    if (webAgentPaths.length === 0) return;
    const itx = this.itx;
    const file = await itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    if (file === null) return;
    const content = file.content;
    const hash = await sha256Hex(content);
    const results = await Promise.allSettled(
      webAgentPaths.map(async (path) => {
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
    const itx = this.itx;
    const file = await itx.repo.readFile({ path: "AGENTS.md" });
    const content =
      file === null
        ? "(AGENTS.md was deleted from /repos/config — no standing project notes.)"
        : `Project AGENTS.md (auto-injected from /repos/config/AGENTS.md — commit updates there to teach every agent):\n\n${file.content}`;
    const hash = await sha256Hex(content);
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
   * The vendored interpreter: parse one accepted assistant output and append
   * its consequences as ONE batch — status first (the code step is born with
   * its activity label), then the script request, then the prose as a chat
   * message. The prose message carries llmRequestOffset so the platform's
   * mirror skips it (the raw assistant text is already in history).
   */
  async #interpretAssistantResponse(event: StreamEvent): Promise<void> {
    // Only interpret output the platform agent processor produced: its stamp means
    // the LLM component authored this event for an accepted request. A raw
    // member append carries no platform stamp and must never gain a path to
    // capability execution here.
    if (event.source?.processor?.slug !== KEEPER_PROCESSOR_SLUG) return;
    const payload = event.payload as {
      role?: string;
      content?: string;
      llmRequestOffset?: number;
    };
    if (payload.role !== "assistant") return;
    if (typeof payload.llmRequestOffset !== "number") return;
    if (typeof payload.content !== "string") return;
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
   * renders nothing: returning no value is how an agent ends its turn.
   */
  async #renderScriptSettlement(event: StreamEvent): Promise<void> {
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
   * platform interpreter): the inline copy becomes a preview plus a
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
   * or the platform interpreter on a historical stream) already recorded this
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

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
