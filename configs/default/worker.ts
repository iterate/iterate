import { DocsApp } from "@iterate-com/docs";
import { GithubAiLinter } from "iterate/starter-apps/github-ai-linter";
import { GuestbookApp } from "iterate/starter-apps/guestbook";
import { MediaApp } from "iterate/starter-apps/media";
import { NotesApp } from "iterate/starter-apps/notes";
import {
  IterateWorkerEntrypoint,
  type AgentBirthDefaultsValue,
  type StreamEvent,
} from "iterate/sdk";
import { TodoApp } from "iterate/starter-apps/todo";

// An iterate project is, in the abstract, just a fetch function.
// HTTP clients on the internet can send us Requests, and we will send responses and
// occasionally send HTTP requests outwards to the world to take influence on it.
//
// Internally, different parts of a project communicate by appending and subscribing to append-only
// event streams.
//
// Hence, the essence of an iterate project can be expressed as two functions:
// { fetch, processEvent }

export default class ProjectWorker extends IterateWorkerEntrypoint {
  #aiLintApp = GithubAiLinter.create(this.env, {
    policyVersion: "2",
    rules: {
      paths: [
        "rules/structure/no-small-single-use-helper.md",
        "rules/typescript/explain-type-cast.md",
        "rules/typescript/no-inferable-type-annotation.md",
      ],
      repoPath: "/repos/config",
    },
  });
  #docsApp = DocsApp.create(this.env, {
    auth: { policy: "project-member" },
    proxy: {
      origin: "https://docs.iterate.workers.dev",
      originOverrideKvKey: "docs-app-origin",
    },
  });
  #guestbookApp = GuestbookApp.create(this.env);
  #mediaApp = MediaApp.create(this.env);
  #notesApp = NotesApp.create(this.env);
  #todoApp = TodoApp.create(this.env);

  /** Agent-callable app helpers: `itx.worker.docs.link({ workspace, path })`
   * mints the document view, `link({ workspace, repo, task? })` the board. */
  get docs() {
    return this.#docsApp.rpc;
  }

  /**
   * STANDING AGENT CONTEXT — the pattern to copy for any always-on knowledge.
   *
   * Every agent in this project carries the config repo's AGENTS.md as a
   * keyed context item: appended at agent birth, and re-synced to EVERY
   * agent whenever a config-repo commit lands. Covered keyed context is
   * append-only (an agent that already ran keeps old occurrences until
   * compaction), so the sync appends ONLY on a real change — it reads each
   * agent's current slot first, and a deleted AGENTS.md supersedes with a
   * tombstone rather than lingering forever. The idempotency key is unique
   * per TRANSITION (content hash + the occurrence it replaces): redeliveries
   * dedupe, reverting to earlier content still supersedes, and an edited
   * wrapper can never reuse a key with a different body.
   * dont-trigger-request means this never wakes an agent by itself. This
   * content rides every LLM request of every agent — keep AGENTS.md lean.
   * (Known narrow race: an agent born while a commit's fan-out is running
   * can end up one version behind until the next AGENTS.md change.)
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
          idempotencyKey: `iterate/config/agents-md:${hash}:after-${slot?.offset ?? 0}`,
          payload: {
            content,
            key: "config/agents-md",
            llmRequestPolicy: { behaviour: "dont-trigger-request" },
            // SYSTEM role on purpose: compaction keeps keyed system facts
            // (collapsed to the latest occurrence) — a developer item would
            // be dropped at the first compaction, and the unchanged-content
            // re-sync would then dedupe against the birth append forever.
            role: "system",
          },
        });
      }),
    );
    // Attempt every agent before failing: the batch is redelivered
    // at-least-once on a throw, and the per-transition keys turn retries of
    // the agents that DID land into no-ops.
    const failed = results.find((result) => result.status === "rejected");
    if (failed !== undefined && failed.status === "rejected") throw failed.reason;
  }

  /**
   * THE PROJECT'S PROMPT, published as data: the project root's generic
   * defaults store (`project/defaults-configured`, latest occurrence wins
   * per key) holds this repo's birth events under the "agents/birth-defaults"
   * key, and the platform's agent-creation door folds them into every agent
   * birth batch — so agents in this project are BORN with this repo's
   * prompts/agent-system-prompt.md as their system prompt. Edit that file
   * and commit to change it — the content-hash key re-publishes and the
   * newest event wins; no platform deploy. Deleting the file publishes an
   * EMPTY list, which restores the platform's embedded fallback prompt
   * (identical text until you fork the file). Rough token budget: prompts
   * ride every LLM request, so a much larger file mostly buys latency and
   * cost — keep it lean.
   */
  async #publishAgentBirthDefaults(): Promise<void> {
    const itx = this.itx;
    const file = await itx.repo.readFile({ path: "prompts/agent-system-prompt.md" });
    const birthEvents: AgentBirthDefaultsValue["birthEvents"] =
      file === null
        ? []
        : [
            {
              type: "events.iterate.com/agents/context-added",
              payload: {
                // The platform's embedded copy of this file is newline-stripped;
                // publishing the same normalization keeps "unchanged file" a
                // byte-identical no-op.
                content: file.content.replace(/\n$/, ""),
                key: "agent/system-prompt",
                role: "system",
              },
            },
          ];
    // Best-effort size guard (~4 chars/token): the platform's own default
    // prompt is budget-tested at ~4.3k tokens; warn well before a fork's
    // edits silently double every request's cost.
    if (file !== null && file.content.length > 6_000 * 4) {
      console.warn(
        `prompts/agent-system-prompt.md is ~${Math.round(file.content.length / 4)} tokens; ` +
          "it rides every LLM request of every agent — consider trimming.",
      );
    }
    const encoded = new TextEncoder().encode(JSON.stringify(birthEvents));
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const hash = [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    await itx.streams.get("/").append({
      type: "events.iterate.com/project/defaults-configured",
      // New prefix on purpose: the stream rejects same-key-different-body
      // appends, so the generic event must not reuse the legacy
      // `iterate/config/agent-birth-defaults:` keys.
      idempotencyKey: `iterate/config/defaults:agents/birth-defaults:${hash}`,
      payload: {
        key: "agents/birth-defaults",
        value: { birthEvents } satisfies AgentBirthDefaultsValue,
      },
    });
  }

  // The base class delivers committed events on ANY stream here at least once and in
  // per-stream order.
  protected override async processEvent(event: StreamEvent): Promise<void> {
    switch (event.type) {
      case "events.iterate.com/project/created": {
        if (event.path !== "/") break;
        const instructions = await this.itx.repo.readFile({ path: "ONBOARDING.md" });
        if (instructions === null) {
          throw new Error("The default template enables onboarding but ONBOARDING.md is missing.");
        }

        const onboardingAgent = this.itx.agents.get("/agents/onboarding");
        await onboardingAgent.create();
        await onboardingAgent.append(
          {
            type: "events.iterate.com/agents/context-added",
            idempotencyKey: "iterate/config/onboarding-instructions:v1",
            payload: {
              role: "system",
              key: "config/onboarding-instructions",
              content: instructions.content,
              llmRequestPolicy: { behaviour: "dont-trigger-request" },
            },
          },
          {
            type: "events.iterate.com/agents/context-added",
            idempotencyKey: "iterate/config/onboarding-start:v1",
            payload: {
              role: "developer",
              key: "config/onboarding-start",
              content:
                "Begin onboarding now. The project owner just created this project. Welcome them, then follow the onboarding instructions one question at a time.",
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          },
        );

        const [{ slug }, clients] = await Promise.all([
          this.itx.identity(),
          this.itx.clients.list(),
        ]);
        const projectHomePath = `/projects/${slug}`;
        const onboardingUrl = `/projects/${slug}/agents/streams/agents/onboarding`;
        await Promise.all(
          clients
            .filter((client) => client.connected && client.path.startsWith("/clients/os-app/"))
            .map(async (client) => {
              const browserClient = this.itx.clients.get(client.path);
              const currentUrl = await browserClient.invokeCapability({
                path: ["capabilities", "browser", "url"],
              });
              if (
                typeof currentUrl !== "string" ||
                new URL(currentUrl).pathname.replace(/\/$/, "") !== projectHomePath
              ) {
                return;
              }
              await browserClient.invokeCapability({
                path: ["capabilities", "browser", "navigate"],
                args: [onboardingUrl],
              });
            }),
        );
        break;
      }
      case "events.iterate.com/agent/created": {
        // The birth event on the agent's own stream (copies carry
        // source.copiedFrom and must not re-target the collection stream).
        if (event.source?.copiedFrom !== undefined) break;
        await this.#syncAgentsMdContext([event.path]);
        break;
      }
      case "events.iterate.com/repo/commit-completed": {
        // Any config-repo commit MAY have changed AGENTS.md — the sync's
        // read-compare step turns the ones that didn't into no-ops.
        if (event.path !== "/repos/config") break;
        const itx = this.itx;
        const agents = await itx.agents.list();
        await this.#syncAgentsMdContext(agents.map((agent) => agent.path));
        break;
      }
      case "events.iterate.com/project/heartbeat-triggered": {
        if (event.path !== "/") break;
        console.log("Project heartbeat fired", { scheduleKey: event.payload?.scheduleKey });
        // Write arbitrary periodic work against itx here:
        // await this.itx.scheduler.set(/* ... */);
        break;
      }
      case "events.iterate.com/stream/woken": {
        if (event.path !== "/") break;
        // Write arbitrary project-stream wake work against itx here:
        // await this.itx.streams.get("/").append(/* ... */);
        break;
      }
      case "events.iterate.com/project/worker-updated": {
        if (event.path !== "/") break;
        // The platform appends this only after the current config worker has
        // built, loaded, and answered. Put arbitrary idempotent ITX calls
        // directly in this case.
        await this.itx.scheduler.set({
          key: "iterate/config/heartbeat/every-15-minutes",
          recurrence: { every: 15 * 60 },
          script: `async (itx, schedule, trigger) => {
            await itx.streams.get("/").append({
              type: "events.iterate.com/project/heartbeat-triggered",
              idempotencyKey: "iterate/config/heartbeat:" + trigger.executionId,
              payload: { scheduleKey: schedule.key },
            });
          }`,
        });
        // Any commit MAY have changed the prompt file; unchanged content
        // dedupes on the content-hash key.
        await this.#publishAgentBirthDefaults();
        break;
      }
      default:
        break;
    }

    await this.#aiLintApp.processEvent(event);
    await this.#guestbookApp.processEvent(event);
    await this.#mediaApp.processEvent(event);
    await this.#notesApp.processEvent(event);
  }

  async fetch(req: Request): Promise<Response> {
    const app = req.headers.get("x-iterate-app");
    if (app === "todo") {
      const authResponse = await this.fetchProjectAuth(req, { policy: "project-member" });
      if (authResponse) return authResponse;
      return this.#todoApp.fetch(req);
    }
    if (app === "guestbook") {
      return this.#guestbookApp.fetch(req);
    }
    if (app === "docs") {
      return this.#docsApp.fetch(req);
    }
    if (app) return new Response(`unknown app: ${app}`, { status: 404 });

    const url = new URL(req.url);
    const hostKind = req.headers.get("x-iterate-host-kind");
    const appUrl = (slug: string) =>
      `${url.protocol}//${hostKind === "custom" ? `${slug}.${url.host}` : `${slug}--${url.host}`}/`;
    return new Response(
      `<!doctype html>
        <html>
          <body>
            <main>
              <p>Hello from your iterate project worker.</p>
              <ul>
                <li><a href="${appUrl("todo")}">todo</a> (LiveState + Cap'n Web, project members only)</li>
                <li><a href="${appUrl("guestbook")}">guestbook</a> (stream processor reduce on /guestbook, public)</li>
                <li><a href="${appUrl("docs")}">docs</a> (workspace documents and the task board, project members only)</li>
              </ul>
              <p>Edit worker.ts in the project repo to change this.</p>
            </main>
          </body>
        </html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}
