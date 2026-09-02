import { DocsApp } from "@iterate-com/docs";
import {
  IterateWorkerEntrypoint,
  type StatefulDynamicWorkerRef,
  type StreamEvent,
} from "iterate/sdk";
import { isIdempotencyConflict, userMessageDescriberSubscription } from "iterate/processors";
import { CodemodeInterpreterContract } from "./codemode-interpreter.ts";

// THE CODEMODE-TAG EXPERIMENT — this project's agents respond with markdown
// plus one embedded <codemode status="..."> tag instead of a bare ```ts
// fence, and THIS FILE wires that up. The platform births every agent
// with default response parsing ON and a HIGH debounce (60s); this worker
// reacts to `agent/created`, turns default parsing OFF, re-adds ONLY the
// `output-formatting` section of the platform prompt with the codemode
// grammar (a plain keyed context-added — re-adding a key IS the update, and
// inside the un-sent birth window it coalesces in place, free; the rest of
// the platform prompt stands untouched), and lowers the debounce to the
// ordinary 250ms — the done-configuring signal, which releases a held first
// turn immediately.
// The INTERPRETATION itself — parse the tag, append its consequences, render
// script results back, stream ephemeral render deltas — lives in
// codemode-interpreter.ts, hosted as a stream-processor facet on each agent
// stream. This worker's remaining job is configuration: convert newborn
// agents to the dialect and install the interpreter subscription. (The
// interpretation used to run right here on the project-worker push lane,
// which is observation-grade — a failed delivery is skipped, not retried,
// and ephemeral events never reach it — so a dropped delivery quietly killed
// a turn. The facet lane is at-least-once with keepalive recovery, and it
// receives the ephemeral token stream, which is what makes live prose/script
// classification possible.)
//
// Everything happens through public stream events any project member could
// append — no platform privileges involved. The grammar section's content
// lives at prompts/agent-system-prompt.md in this repo (JUST the
// output-formatting section, not a whole-prompt fork); the parser at
// codemode-format.ts. Editing either is a commit — no platform deploy.
//
// KNOWN LIMITS (this is an experiment): Slash commands (/example, /script)
// are platform interpretation and therefore inert here. Slack/Telegram/email
// and MCP session agents keep default parsing and their own channel prompts
// untouched — the conversion below only fires for plain web agents. If this
// worker is down at a birth, the agent answers after ~60s with the
// platform's fenced-ts defaults — coherent, just not the codemode dialect —
// until the next deploy's sweep converts it.

/** The one section this experiment re-adds: the platform prompt's
 * response-format section. Everything else stays the platform's. */
const OUTPUT_FORMATTING_KEY = "output-formatting";

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
        // ORDER MATTERS: the conversion batch ends with the lowered debounce
        // — the done-configuring signal that releases the held first turn —
        // so everything the first turn should see (AGENTS.md included) must
        // land BEFORE it.
        if (event.source?.copiedFrom !== undefined) break;
        await this.#syncAgentsMdContext([event.path]);
        await this.#configureNewbornAgent(event.path);
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
        // The birth reaction IS the conversion: one atomic batch of parsing
        // off + codemode prompt + debounce release, all idempotency-keyed —
        // already-converted agents dedupe to a no-op, and a prompt changed
        // since their conversion supersedes via its content-hash key. A
        // separate flag-then-sync sweep raced its own append (the snapshot
        // gate read a fold that had not reduced the flag yet) and skipped
        // the prompt, leaving parsing off with the fenced prompt standing.
        for (const agent of agents) await this.#configureNewbornAgent(agent.path);
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
      default:
        break;
    }
  }

  /**
   * THE OPT-IN, at birth: the platform births agents with default parsing ON
   * and a high (60s) debounce — that window is exactly for this reaction.
   * ONE atomic batch turns default parsing off, supersedes the platform's
   * keyed system-prompt slot with the codemode grammar, and lowers the
   * debounce to the ordinary 250ms (LAST on purpose: done configuring —
   * releases a held first turn). Gated to plain web agents: integration
   * agents (slack/telegram/email) keep the fenced format their channel
   * prompts teach.
   */
  async #configureNewbornAgent(agentPath: string): Promise<void> {
    if (!agentPath.startsWith("/agents/")) return;
    if (/^\/agents\/(slack|telegram|email|mcp)\//.test(agentPath)) return;
    await this.#installInterpreterSubscription(agentPath);
    await this.#installUserMessageDescriber(agentPath);
    const conversion = await this.#codemodeConversion();
    await this.#appendUnlessAlreadyRecorded(() =>
      this.itx.agents.get(agentPath).append(...conversion, {
        // LAST on purpose: done configuring — releases a held first turn.
        type: "events.iterate.com/agent/configured",
        idempotencyKey: "codemode-tag/birth-debounce:v1",
        payload: { config: { llmRequestDebounceMs: 250 } },
      }),
    );
  }

  /** Put the user-message describer facet on this agent's stream — the
   * reusable package processor that parses the mobile composer's html
   * attachment parts into typed render facts (its entry file re-exports the
   * facet class from iterate/processors). */
  async #installUserMessageDescriber(agentPath: string): Promise<void> {
    const payload = userMessageDescriberSubscription(agentPath, "user-message-describer.ts");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.#appendUnlessAlreadyRecorded(() =>
      this.itx.streams.get(agentPath).append({
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `codemode-tag/user-message-describer:${hash}`,
        payload,
      }),
    );
  }

  /**
   * Put the interpreter facet on this agent's stream — BEFORE the conversion
   * batch, so the first interpreted turn already has its interpreter. The
   * subscription's filter is derived from the interpreter contract's
   * `consumes` (never hand-written: a type in one list and not the other
   * would silently never deliver), and the idempotency key hashes the
   * payload so a changed contract reinstalls while an unchanged one dedupes.
   */
  async #installInterpreterSubscription(agentPath: string): Promise<void> {
    const worker: StatefulDynamicWorkerRef = {
      className: "CodemodeInterpreterFacet",
      // Load-bearing: the key names the durable worker — one interpreter
      // facet per agent stream.
      durableWorkerKey: "codemode-interpreter",
      path: agentPath,
      source: {
        createWorker: {
          entryPoint: "codemode-interpreter.ts",
          files: { repoPath: "/repos/config", type: "repo" },
        },
      },
      type: "stateful",
    };
    const payload = {
      name: CodemodeInterpreterContract.slug,
      description: "Interpret codemode-tag assistant output in this stream's own Durable Object.",
      filter: { eventTypes: [...CodemodeInterpreterContract.consumes] },
      receiver: {
        action: "facet-processor",
        source: { kind: "userspace", worker },
      },
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await this.#appendUnlessAlreadyRecorded(() =>
      this.itx.streams.get(agentPath).append({
        type: "events.iterate.com/stream/subscription-configured",
        idempotencyKey: `codemode-tag/interpreter-subscription:${hash}`,
        payload,
      }),
    );
  }

  /** Parsing off + the codemode grammar re-added under the platform prompt's
   * `output-formatting` key — the everyday event: inside the un-sent birth
   * window the section coalesces in place, so the swapped grammar renders in
   * the standing document as if authored there, and the other nine sections
   * stand untouched. A missing prompt file converts nothing: the platform
   * prompt AND platform parsing stay — this experiment degrades to
   * fenced-ts, never to an agent taught a grammar nobody interprets. (The
   * release above still happens either way: a degraded agent must not also
   * keep the 60s birth debounce.) */
  async #codemodeConversion() {
    const file = await this.itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    if (file === null) return [];
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(file.content));
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return [
      {
        type: "events.iterate.com/agent/configured" as const,
        idempotencyKey: "codemode-tag/birth-parsing-off:v1",
        payload: { config: { interpretResponses: false } },
      },
      {
        type: "events.iterate.com/agents/context-added" as const,
        idempotencyKey: `codemode-tag/birth-prompt:${hash}`,
        payload: {
          content: file.content,
          key: OUTPUT_FORMATTING_KEY,
          llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
          role: "system" as const,
        },
      },
    ];
  }

  /**
   * Keep every converted agent's `output-formatting` section current with
   * the repo's grammar file — the same plain keyed add as the birth
   * reaction; adaptive placement does the rest (un-sent coalesces free,
   * sent lands temporally with supersedes). The content-equality skip is
   * about SENT sections: re-adding identical content to an un-sent section
   * coalesces to the same bytes anyway, but on a sent one it would append a
   * pointless duplicate temporal copy. Per-transition idempotency keys;
   * dont-trigger-request means this never wakes an agent by itself.
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
        const slot = latestSectionOccurrence(snapshot.state, OUTPUT_FORMATTING_KEY);
        if (slot?.content === content) return;
        await agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `codemode-tag/system-prompt:${hash}:after-${slot?.offset || 0}`,
          payload: {
            content,
            key: OUTPUT_FORMATTING_KEY,
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
   * sync: the hot `config/agents-md` section (rendered last in the standing
   * document), re-added as a plain keyed context-added on a real change,
   * tombstone on deletion. The content-equality skip prevents appending an
   * identical temporal copy once the section has been sent.
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
        const slot = latestSectionOccurrence(snapshot.state, "config/agents-md");
        if (slot?.content === content) return;
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

/**
 * The latest occurrence of a keyed section in the agent's reduced state —
 * one findLast over `contextItems`. The syncs read this to skip re-adding
 * content a sent section already holds: a duplicate copy teaches the model
 * nothing.
 */
function latestSectionOccurrence(
  state: {
    contextItems: { kind: string; offset: number; key?: string; payload?: { content: string } }[];
  },
  key: string,
): { offset: number; content: string | undefined } | null {
  const item = state.contextItems.findLast(
    (candidate) => candidate.kind === "section" && candidate.key === key,
  );
  if (item === undefined) return null;
  return { offset: item.offset, content: item.payload?.content };
}
