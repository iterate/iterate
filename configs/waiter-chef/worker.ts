import { DocsApp } from "@iterate-com/docs";
import { IterateWorkerEntrypoint, type StreamEvent } from "iterate/sdk";
import { isIdempotencyConflict } from "iterate/processors";
import { parseWaiterResponse } from "./waiter-format.ts";

// THE WAITER/CHEF EXPERIMENT — front-of-house / back-of-house agent service,
// implemented entirely in this config repo. Structure and several mechanisms
// (birth-defaults publishing, keyed context syncs, the assistant-output
// interpreter) are adapted from configs/codemode-tag/worker.ts in
// iterate/iterate; the modification is the two-lane cast:
//
//   WAITER — every web chat agent (/agents/web/…). Born via project birth
//   defaults with the headless driver: no tools, no codemode, ONE fast LLM
//   call per turn. Speaks prose plus <kitchen>/<peek/> tags; THIS worker is
//   the interpreter.
//
//   CHEF — /agents/chef/<same slug>, created lazily by this worker on the
//   first kitchen order. The birth-defaults pathPrefix doesn't match, so the
//   chef is a bone-stock platform agent (classic driver, default prompt, all
//   tools) plus a briefing context item teaching the kitchen protocol.
//
//   Relay lanes: waiter <kitchen> orders become user-role messages on the
//   chef's stream; every chef chat message comes back to the waiter as a
//   developer note; <peek/> snapshots the chef's processor state without
//   disturbing it.
//
// Everything is public stream events any project member could append — no
// platform privileges. Iterating on the feel — waiter prompt, menu, chef
// briefing, the tag grammar, the model knobs below — is a commit to this
// repo. No platform deploy.
//
// KNOWN LIMITS (inherited from the codemode-tag experiment): delivery to this
// worker is observation-grade — an event this handler fails on is SKIPPED,
// not retried forever, so a dropped delivery can quietly lose a relay (a new
// message starts fresh). Slack/telegram/email agents and the onboarding agent
// are untouched (their paths fall outside /agents/web/).

const WAITER_PREFIX = "/agents/web/";
const CHEF_PREFIX = "/agents/chef/";
const HEADLESS_PROCESSOR_SLUG = "agent-headless";
const SYSTEM_PROMPT_KEY = "agent/system-prompt";

// ---------------------------------------------------------------------------
// FEEL-EVAL KNOBS — commit a change to any of these and new turns pick it up.
// ---------------------------------------------------------------------------
/** The waiter's model. The whole gpt-5 family runs reasoning-effort medium
 * through the platform transport, so a smaller gpt-5 isn't automatically
 * snappier — candidates for real speed are non-reasoning partner models
 * (enumerate with `await itx.ai.models()` in the repl). */
const WAITER_MODEL = "openai/gpt-5.6-terra";
/** Platform default is 250ms; the waiter's whole job is feeling immediate. */
const WAITER_DEBOUNCE_MS = 100;
/** Kitchen notes relayed to the waiter ride its autonomous-turn budget (they
 * are developer context, not diner messages). Roomy so a long cook's worth of
 * updates never mutes the waiter. */
const WAITER_MAX_AUTONOMOUS_TURNS = 100;
/** Longest chef-note / peek excerpt relayed into the waiter's context. */
const RELAY_EXCERPT_CHARS = 1_500;

/** Supersedes the platform's boot context (key agent/boot-context) for
 * waiters: the stock text teaches every agent its itx scope and workspace,
 * which primes a tool-less waiter to attempt tool calls — observed leaking
 * harmony-style call syntax into diner-visible replies. Static on purpose so
 * it can ride the birth batch (defaults append last, so it supersedes the
 * platform slot atomically at birth). */
const WAITER_BOOT_CONTEXT = [
  "Context for this agent: you are the front-of-house waiter for one table (this chat).",
  "A dedicated chef agent is paired with this table: your <kitchen> tags reach it and its notes come back to you automatically — you never need to address it by name or path.",
  "The diner can watch the kitchen directly from the project's agents list (the chef chat shares this chat's name).",
  "You have no tools, no code scope, and no workspace.",
].join("\n");

const chefPathForWaiter = (waiterPath: string) =>
  CHEF_PREFIX + waiterPath.slice(WAITER_PREFIX.length);
const waiterPathForChef = (chefPath: string) => WAITER_PREFIX + chefPath.slice(CHEF_PREFIX.length);

const excerpt = (text: string) =>
  text.length <= RELAY_EXCERPT_CHARS ? text : `${text.slice(0, RELAY_EXCERPT_CHARS)}…`;

/** The prompt projection prefixes every context item with `@<offset>`
 * bookkeeping, and the waiter model sometimes imitates it at the start of a
 * reply. The prompt tells it not to; this strip is the backstop so the diner
 * never sees one either way. */
const stripLeadingOffsetMarker = (text: string) => text.replace(/^@\d+\s*\n?/, "").trim();

async function contentHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
      case "events.iterate.com/project/worker-updated": {
        if (event.path !== "/") break;
        await this.#publishWaiterBirthDefaults();
        await this.#syncAllStandingContext();
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        // Any config-repo commit MAY have changed a prompt or the menu — the
        // syncs' read-compare steps turn the ones that didn't into no-ops.
        // THIS is the iteration loop: edit, commit, next turns feel different.
        if (event.path !== "/repos/config") break;
        await this.#publishWaiterBirthDefaults();
        await this.#syncAllStandingContext();
        break;
      }
      case "events.iterate.com/agent/created": {
        // The birth event on the agent's own stream (copies carry
        // source.copiedFrom and must not be re-briefed).
        if (event.source?.copiedFrom !== undefined) break;
        if (event.path.startsWith(WAITER_PREFIX)) {
          await this.#syncMenuContext([event.path]);
          await this.#syncKeyedContext([event.path], {
            key: "agent/boot-context",
            content: WAITER_BOOT_CONTEXT,
          });
        }
        if (event.path.startsWith(CHEF_PREFIX)) {
          await this.#syncChefBriefing([event.path]);
        }
        break;
      }
      case "events.iterate.com/agents/context-added": {
        await this.#interpretWaiterResponse(event);
        break;
      }
      case "events.iterate.com/agents/web-message-sent": {
        await this.#relayChefMessage(event);
        break;
      }
      default:
        break;
    }
  }

  /**
   * THE CAST SELECTOR: the platform's generic agent-creation door folds the
   * project's latest birth-defaults event into every matching birth batch.
   * `pathPrefix` scopes it to web chats — so every new chat is BORN a waiter
   * (headless driver + waiter prompt + the fast-lane config), while chefs,
   * the onboarding agent, and channel agents fall outside the prefix and stay
   * stock. Content-hash keyed: editing the prompt or a knob re-publishes and
   * the newest event wins at the door.
   */
  async #publishWaiterBirthDefaults(): Promise<void> {
    const itx = await this.itx;
    const file = await itx.repo.readFile({ path: "prompts/waiter-system-prompt.md" });
    // A deleted waiter prompt degrades to stock agents for new chats (empty
    // list restores platform defaults), never to a promptless waiter.
    const birthEvents =
      file === null
        ? []
        : [
            {
              type: "events.iterate.com/agent/configured",
              payload: {
                config: {
                  driver: HEADLESS_PROCESSOR_SLUG,
                  llm: { model: WAITER_MODEL },
                  llmRequestDebounceMs: WAITER_DEBOUNCE_MS,
                  maxAutonomousTurns: WAITER_MAX_AUTONOMOUS_TURNS,
                },
              },
            },
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                content: file.content.replace(/\n$/, ""),
                key: SYSTEM_PROMPT_KEY,
                role: "system",
              },
            },
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                content: WAITER_BOOT_CONTEXT,
                key: "agent/boot-context",
                role: "system",
              },
            },
            {
              type: "events.iterate.com/stream/subscription-configured",
              payload: {
                name: HEADLESS_PROCESSOR_SLUG,
                receiver: { action: "facet-processor", source: { kind: "builtin" } },
              },
            },
          ];
    const hash = await contentHash(JSON.stringify(birthEvents));
    await this.#appendUnlessAlreadyRecorded(() =>
      itx.streams.get("/").append({
        type: "events.iterate.com/project/agent-birth-defaults-configured",
        idempotencyKey: `waiter-chef/birth-defaults:${hash}`,
        payload: {
          matches: { pathPrefix: WAITER_PREFIX },
          birthEvents,
        },
      }),
    );
  }

  /** One sweep over the cast: prompt + menu to existing waiters, briefing to
   * existing chefs. Each sync is keyed and read-compared, so repeat sweeps
   * are no-ops. */
  async #syncAllStandingContext(): Promise<void> {
    const itx = await this.itx;
    const agents = await itx.agents.list();
    const waiters = agents
      .map((agent) => agent.path)
      .filter((path) => path.startsWith(WAITER_PREFIX));
    const chefs = agents.map((agent) => agent.path).filter((path) => path.startsWith(CHEF_PREFIX));
    await this.#syncWaiterPromptContext(waiters);
    await this.#syncMenuContext(waiters);
    await this.#syncKeyedContext(waiters, {
      key: "agent/boot-context",
      content: WAITER_BOOT_CONTEXT,
    });
    await this.#syncChefBriefing(chefs);
  }

  /**
   * Post-birth prompt edits for EXISTING waiter chats (new ones get the
   * prompt at birth). Gated on the headless driver: an agent still on the
   * classic driver (born before the defaults event existed) interprets its
   * own output, and the waiter grammar would break every turn.
   */
  async #syncWaiterPromptContext(waiterPaths: string[]): Promise<void> {
    if (waiterPaths.length === 0) return;
    const itx = await this.itx;
    const file = await itx.repo.readFile({ path: "prompts/waiter-system-prompt.md" });
    if (file === null) return;
    const content = file.content.replace(/\n$/, "");
    const hash = await contentHash(content);
    const results = await Promise.allSettled(
      waiterPaths.map(async (path) => {
        const agent = itx.agents.get(path);
        const snapshot = await agent.processor.snapshot();
        if (snapshot.state.config.driver !== HEADLESS_PROCESSOR_SLUG) return;
        const slot = snapshot.state.contextItems.findLast(
          (item) => item.payload.key === SYSTEM_PROMPT_KEY,
        );
        if (slot?.payload.content === content) return;
        await agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `waiter-chef/system-prompt:${hash}:after-${slot?.offset || 0}`,
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

  /** The waiter's MENU.md as keyed standing context — same recipe as the
   * default template's AGENTS.md sync (keyed system context, per-transition
   * keys, appends only on a real change, dont-trigger-request). */
  async #syncMenuContext(waiterPaths: string[]): Promise<void> {
    if (waiterPaths.length === 0) return;
    const itx = await this.itx;
    const file = await itx.repo.readFile({ path: "MENU.md" });
    const content =
      file === null
        ? "(MENU.md was deleted from /repos/config — no menu; ask the kitchen about everything.)"
        : `The menu (auto-injected from /repos/config/MENU.md — commit updates there to change it):\n\n${file.content}`;
    await this.#syncKeyedContext(waiterPaths, { key: "waiter-chef/menu", content });
  }

  /** The chef's kitchen briefing as keyed standing context. The chef keeps
   * the stock platform prompt; this rides alongside it. */
  async #syncChefBriefing(chefPaths: string[]): Promise<void> {
    if (chefPaths.length === 0) return;
    const itx = await this.itx;
    const file = await itx.repo.readFile({ path: "prompts/chef-briefing.md" });
    if (file === null) return;
    await this.#syncKeyedContext(chefPaths, {
      key: "waiter-chef/briefing",
      content: file.content,
    });
  }

  /** Shared keyed-context sync: append only on a real change, key unique per
   * transition (content hash + the occurrence it replaces), system role so
   * compaction keeps the latest occurrence. */
  async #syncKeyedContext(agentPaths: string[], input: { key: string; content: string }) {
    const itx = await this.itx;
    const hash = await contentHash(input.content);
    const results = await Promise.allSettled(
      agentPaths.map(async (path) => {
        const agent = itx.agents.get(path);
        const snapshot = await agent.processor.snapshot();
        const slot = snapshot.state.contextItems.findLast((item) => item.payload.key === input.key);
        if (slot?.payload.content === input.content) return;
        await agent.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `${input.key}:${hash}:after-${slot?.offset || 0}`,
          payload: {
            content: input.content,
            key: input.key,
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
   * The waiter's interpreter — the userland twin of the platform's response
   * interpretation, for the waiter grammar: prose to the diner, orders to the
   * kitchen, peeks answered from the chef's processor snapshot.
   */
  async #interpretWaiterResponse(event: StreamEvent): Promise<void> {
    if (!event.path.startsWith(WAITER_PREFIX)) return;
    // Only interpret output the HEADLESS processor produced: its stamp means
    // the LLM component authored this event for an accepted request on a
    // stream that opted in. A raw member append carries no platform stamp and
    // classic-processed output was already interpreted platform-side.
    if (event.source?.processor?.slug !== HEADLESS_PROCESSOR_SLUG) return;
    const payload = event.payload as {
      role?: string;
      content?: string;
      llmRequestOffset?: number;
    };
    if (payload.role !== "assistant") return;
    if (typeof payload.llmRequestOffset !== "number") return;
    if (typeof payload.content !== "string") return;
    const outcome = parseWaiterResponse(payload.content);
    const itx = await this.itx;
    const waiter = itx.agents.get(event.path);
    if (outcome.kind === "malformed") {
      await this.#appendUnlessAlreadyRecorded(() =>
        waiter.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `waiter-chef/format-feedback@${event.offset}`,
          payload: {
            role: "developer",
            content: outcome.feedback,
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        }),
      );
      return;
    }
    // Orders first (so "I've sent it to the kitchen" is true by the time the
    // diner reads it), then the prose, then any peek report.
    const chefPath = chefPathForWaiter(event.path);
    if (outcome.orders.length > 0) {
      await this.#ensureChef(chefPath);
      const chef = itx.agents.get(chefPath);
      for (const [index, order] of outcome.orders.entries()) {
        await this.#appendUnlessAlreadyRecorded(() =>
          chef.append({
            type: "events.iterate.com/agents/context-added",
            idempotencyKey: `waiter-chef/order@${event.offset}#${index}`,
            payload: {
              role: "user",
              content: `Order from the waiter (front of house), relaying the diner:\n\n${order}`,
            },
          }),
        );
      }
    }
    if (outcome.prose !== undefined && stripLeadingOffsetMarker(outcome.prose) !== "") {
      const prose = stripLeadingOffsetMarker(outcome.prose);
      await this.#appendUnlessAlreadyRecorded(() =>
        waiter.append({
          type: "events.iterate.com/agents/web-message-sent",
          idempotencyKey: `waiter-chef/prose@${event.offset}`,
          payload: { message: prose, llmRequestOffset: payload.llmRequestOffset },
        }),
      );
    }
    if (outcome.peek) {
      const report = await this.#peekAtChef(chefPath);
      await this.#appendUnlessAlreadyRecorded(() =>
        waiter.append({
          type: "events.iterate.com/agents/context-added",
          idempotencyKey: `waiter-chef/peek@${event.offset}`,
          payload: {
            role: "developer",
            content: report,
            llmRequestPolicy: { behaviour: "after-current-request" },
          },
        }),
      );
    }
  }

  /** Lazy chef creation through the SAME generic door as every agent — the
   * birth-defaults prefix doesn't match, so the chef is born stock. create()
   * dedupes on its birth keys, so calling per order is safe; the briefing
   * lands before the first order is appended. */
  async #ensureChef(chefPath: string): Promise<void> {
    const itx = await this.itx;
    await itx.agents.get(chefPath).create();
    await this.#syncChefBriefing([chefPath]);
  }

  /** The over-the-shoulder glance: honest kitchen state from the chef's
   * processor snapshot, without appending anything to the chef's stream. */
  async #peekAtChef(chefPath: string): Promise<string> {
    const itx = await this.itx;
    const snapshot = await itx.agents
      .get(chefPath)
      .processor.snapshot()
      .catch(() => null);
    if (snapshot === null || snapshot.state.contextItems.length === 0) {
      return "Kitchen report: the kitchen hasn't been fired up for this table yet — no order has reached the chef.";
    }
    const state = snapshot.state;
    const busy =
      state.openRequest !== null ||
      state.activeScriptExecutionIds.length > 0 ||
      state.pendingLlmRequestTrigger !== null;
    const lines = [`Kitchen report (over the chef's shoulder):`];
    lines.push(busy ? "- The chef is BUSY cooking right now." : "- The chef is idle.");
    if (state.summary.activity !== undefined) {
      lines.push(`- Current activity label: ${state.summary.activity}`);
    }
    if (state.summary.waitingFor !== undefined) {
      lines.push(`- Waiting on: ${JSON.stringify(state.summary.waitingFor)}`);
    }
    const lastAssistant = state.contextItems.findLast(
      (item) => item.payload.role === "assistant" && typeof item.payload.content === "string",
    );
    const lastWords = lastAssistant?.payload.content;
    if (typeof lastWords === "string") {
      lines.push(`- The chef's most recent words:\n${excerpt(lastWords)}`);
    }
    lines.push(
      "Relay what matters to the diner in your own words. Do not invent detail beyond this report.",
    );
    return lines.join("\n");
  }

  /** Every chef chat message comes back to the waiter as a developer note —
   * the waiter decides what the diner hears. after-current-request means an
   * idle waiter speaks up straight away and a mid-turn waiter finishes its
   * sentence first. */
  async #relayChefMessage(event: StreamEvent): Promise<void> {
    if (!event.path.startsWith(CHEF_PREFIX)) return;
    const payload = event.payload as { message?: string };
    if (typeof payload.message !== "string" || payload.message.trim() === "") return;
    const message = payload.message;
    const waiterPath = waiterPathForChef(event.path);
    const itx = await this.itx;
    await this.#appendUnlessAlreadyRecorded(() =>
      itx.agents.get(waiterPath).append({
        type: "events.iterate.com/agents/context-added",
        idempotencyKey: `waiter-chef/chef-said:${event.path}@${event.offset}`,
        payload: {
          role: "developer",
          content: `The chef says:\n\n${excerpt(message)}`,
          llmRequestPolicy: { behaviour: "after-current-request" },
        },
      }),
    );
  }

  /** An idempotency conflict means another writer (a redelivery of ourselves)
   * already recorded this consequence — losing that race is success. */
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
              <p>Hello from the waiter/chef experiment project.</p>
              <p>Every web chat is a fast, tool-less <strong>waiter</strong>; the <strong>chef</strong> (a full platform agent) cooks in a paired chat at /agents/chef/&lt;slug&gt;. worker.ts in the config repo relays between them. Edit MENU.md or the prompts and commit to iterate on the feel.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
