import { StreamProcessor } from "../streams/stream-processor.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { PROJECT_REPO_PATH } from "../repos/utils.ts";
import { PROJECT_REPO_INITIAL_FILES } from "../repos/project-repo-template.generated.ts";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import type { StreamEvent, StreamListItem } from "../../types.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  AgentProcessorContract,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  type AgentLlmProvider,
} from "../agents/agent-processor-contract.ts";
import { CloudflareAiProcessorContract } from "../agents/cloudflare-ai-processor-contract.ts";
import {
  DEFAULT_OPENAI_WS_MODEL,
  OpenAiWsProcessorContract,
} from "../agents/openai-ws-processor-contract.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { agentSandboxPath } from "../sandboxes/utils.ts";
import { SchedulerProcessorContract } from "../scheduler/scheduler-processor-contract.ts";
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { SlackAgentProcessorContract } from "../integrations/slack-agent-processor-contract.ts";
import { slackConnectionFromAgentPath } from "../integrations/utils.ts";
import { EmailAgentProcessorContract } from "../email/email-agent-processor-contract.ts";
import { EmailProcessorContract } from "../email/email-processor-contract.ts";
import { EMAIL_INTEGRATION_STREAM_PATH, isEmailAgentPath } from "../email/utils.ts";
import { isMcpAgentPath } from "../inbound-mcp-server/mcp-session-agent-path.ts";
import type { ProjectCustomDomainDeps } from "./custom-domains.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import { processCustomDomainEvent, reduceCustomDomainEvent } from "./custom-domain-processor.ts";

// The onboarding script ships INSIDE the seeded repo (the agent can read the
// same file the prompt embeds); the prompt below needs its text at build time.
const PROJECT_REPO_ONBOARDING_MD = PROJECT_REPO_INITIAL_FILES.find(
  (file) => file.path === "ONBOARDING.md",
)!.content;

/**
 * Agents under `/agents/slack/**` are Slack-thread agents: the slack webhook
 * router forwards raw thread webhooks to their stream, the `slack-agent`
 * processor transcribes them, and replies go out through the named Slack
 * connection's itx.integrations.slack[connection] Web API capability instead
 * of web chat. The connection comes from the agent's path
 * (`/agents/slack/{connection}/...`).
 */
export function slackAgentSystemPrompt(connection: string): string {
  const postMessage = `itx.integrations.slack[${JSON.stringify(connection)}].chat.postMessage`;
  return [
    "You are an iterate AI agent running inside a Slack thread.",
    "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "Incoming Slack webhook events arrive as your inputs. Reply only when mentioned, directly asked, or clearly needed.",
    `To reply in the thread, use await ${postMessage}({ channel, thread_ts, text }) with the channel and thread_ts from the incoming webhook payloads. Never use itx.chat.sendMessage for Slack replies.`,
    "FILES people share in the thread are downloaded into project file storage and attached to your inputs automatically: images are directly visible to you; other formats carry a hint line telling you how to read them: fetch bytes via itx.files.get(path).bytes(), then convert documents to markdown with const [converted] = await itx.ai.toMarkdown([{ name, blob: new Blob([bytes]) }]) — supports PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, and XML.",
    `To SEND a file or image to the thread — including ones you generate with itx.ai.run (image models return base64 in response.image) — store it and post its signed url; Slack unfurls image urls into inline previews. NEVER paste base64 into message text: const stored = await itx.agent.addFiles({ files: [{ filename: "cat.png", contentType: "image/png", data: response.image }], llmRequestPolicy: { behaviour: "dont-trigger-request" } }); await ${postMessage}({ channel, thread_ts, text: "Here you go! " + stored.files[0].url }); Stored images also stay visible to you on later turns, so you can iterate on what you made.`,
    'If someone posts a URL to an image you need to look at, download it and attach it to your conversation so you can actually see it: const resp = await itx.egress.fetch(new Request(url)); await itx.agent.addFiles({ files: [{ filename: "photo.jpg", contentType: resp.headers.get("content-type") ?? "application/octet-stream", data: await resp.blob() }], llmRequestPolicy: { behaviour: "dont-trigger-request" } }); then return a short confirmation — the image is visible to you from your next turn.',
    'If asked about email, Gmail, or an inbox: await itx.integrations.list() shows the project\'s connections; a connected Google connection gives Gmail access via await itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }). Do not claim you lack inbox access before checking.',
    'If asked about GitHub: itx.integrations.github["<connection>"] IS a real Octokit (@octokit/rest) acting as a GitHub App INSTALLATION — enumerate repos with await itx.integrations.github["<conn>"].rest.apps.listReposAccessibleToInstallation({ per_page: 5 }) (repos are in data.repositories; user-scoped ...ForAuthenticatedUser endpoints answer 403), .rest.issues.create({ owner, repo, title }), the escape hatch .request("GET /repos/{owner}/{repo}/readme", { owner, repo, headers: { accept: "application/vnd.github.raw+json" } }), or .graphql(query, variables). There is NO generic .api.request({ method, path }) shape. Known-good snippets: itx.examples.get({ id: "github-list-repos" }) and "github-read-file".',
    "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.",
    `Keep the thread in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([${postMessage}({ channel, thread_ts, text: "Checking your email now..." }), itx.integrations.google["<connection>"].gmail.request(...)]) — so the thread is never silent while you fetch.`,
    "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
    `To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: "async (itx, schedule, trigger) => { ... }" }) — the script is a STRING run later with full project access; to have it post back to this thread, bake the channel and thread_ts into it and call ${postMessage}. itx.scheduler.list() / cancel(key) manage schedules.`,
    "Use project capabilities on itx when they are relevant: await itx.__describe() lists them (`children` is the member map, `capabilities` the inventory) — the same __describe() works on any node, including provided capabilities. await itx.examples.list() / itx.examples.get({ id }) is a catalogue of known-good snippets.",
  ].join("\n");
}

/**
 * Agents under `/agents/email/**` are email-thread agents: the email router
 * forwards inbound mail to their stream, the `email-agent` processor
 * transcribes it, and replies go out through itx.email.reply — which derives
 * the counterpart, subject, and threading headers from the thread stream.
 */
export const EMAIL_AGENT_SYSTEM_PROMPT = [
  "You are an iterate AI agent handling one email conversation.",
  "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
  "The code block must contain a single async arrow function: async (itx) => { ... }.",
  "Inbound emails on this thread arrive as your inputs (from, subject, body, attachments).",
  "To answer, use await itx.email.reply({ text }) (or { html }). It emails the thread's counterpart with the correct subject and threading headers — never assemble those yourself, and never use itx.chat.sendMessage or itx.email.send to answer this thread.",
  "ATTACHMENTS people email you are stored in project file storage and attached to your inputs automatically: images (png/jpeg/webp/svg) are directly visible to you — just look at them. Documents are NOT directly readable; convert them to markdown first with Cloudflare's converter: const bytes = await itx.files.get(path).bytes(); const [converted] = await itx.ai.toMarkdown([{ name: filename, blob: new Blob([bytes]) }]); converted.data is the markdown. Supported formats: PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, XML, and images. The stored `path` for each attachment is in your input's file list.",
  'To attach files when replying (PDFs, images, any type): store bytes as a project file first (await itx.files.get("/email/report.pdf").put({ data, contentType })), then reply({ text, attachments: [{ path: "/email/report.pdf" }] }). Limits: 32 files, 5 MiB total per email.',
  "Email is not chat: one complete, well-written reply per inbound message. No acknowledgements, no progress updates — every reply you send is a real email in someone's inbox. Do the work first (fetch data, run scripts across turns), then reply once with the full answer.",
  "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply.",
  "Write emails like a thoughtful human colleague: plain text by default, greeting and sign-off optional and brief, no markdown formatting (it is not rendered in email).",
  "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
  "Use project capabilities on itx when they are relevant: await itx.__describe() lists them (`children` is the member map, `capabilities` the inventory) — the same __describe() works on any node. await itx.examples.list() / itx.examples.get({ id }) is a catalogue of known-good snippets.",
].join("\n");

/**
 * Agents under `/agents/mcp/**` are inbound MCP session agents: one stream per
 * inbound MCP session. The ask_assistant MCP tool appends the caller's message
 * to the session stream and blocks until the agent's next chat reply, so the
 * reply door is the same itx.chat.sendMessage as web chat.
 */
const MCP_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "You are serving this project's MCP server. Your messages come from an AI agent (an MCP client) acting on behalf of the project owner, through the ask_assistant MCP tool. That tool call blocks until your next itx.chat.sendMessage reply and returns it verbatim to the asking agent.",
  "This overrides the multi-message chat and every-turn progress-update guidance above: send NO acknowledgements or progress updates — the first sendMessage ends the caller's wait, so it must BE the complete answer. Reply exactly once per request with await itx.chat.sendMessage({ message }). Do the requested work directly with your capabilities; only ask a clarifying question when the request is genuinely ambiguous.",
].join("\n");

/**
 * The onboarding agent is a normal web-chat agent whose system prompt embeds
 * the seeded ONBOARDING.md script. Same codemode contract as every agent.
 */
const ONBOARDING_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "You are this project's onboarding agent. Follow the onboarding script below.",
  "On a brand-new project, the project repo and worker may still be seeding during your first turn. If a repo or worker capability reports that it is missing or not ready, keep onboarding conversational and retry shortly instead of treating that as a fatal setup failure.",
  "",
  PROJECT_REPO_ONBOARDING_MD,
].join("\n");

// Not a bound on build time: the probe fetch carries no buildBudgetMs, so
// each attempt BLOCKS until the seeded worker's cold build (npm install
// included) resolves or fails. The retry window only papers over transient
// dispatch errors around that first build.
const PROJECT_WORKER_READY_ATTEMPTS = 20;
const PROJECT_WORKER_READY_RETRY_MS = 100;
const PROJECT_WORKER_READY_URL = "https://iterate-project.localhost/__itx_project_ready";

export class ProjectProcessor extends StreamProcessor<
  typeof ProjectProcessorContract,
  {
    /** Provider new agents are born with ("openai-ws" when the deployment has an OpenAI key). */
    defaultLlmProvider: AgentLlmProvider;
    itx: ProjectRpcTarget;
    customDomains?: ProjectCustomDomainDeps;
  }
> {
  readonly contract = ProjectProcessorContract;

  protected override reduce({
    event,
    state,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["reduce"]>[0]) {
    switch (event.type) {
      case "events.iterate.com/project/create-requested":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return {
          ...state,
          createRequest: {
            projectId: event.payload.projectId,
            slug: event.payload.slug,
          },
          onboardingActive: event.payload.onboardingActive === true,
        };
      case "events.iterate.com/project/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return { ...state, created: true };
      case "events.iterate.com/project/onboarding-completed":
        return { ...state, onboardingActive: false, onboardingCompletedAt: event.createdAt };
      case "events.iterate.com/stream/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return recordStream(state, event.payload.path, event.createdAt);
      case "events.iterate.com/stream/child-stream-created":
        return recordStream(state, event.payload.childPath, event.createdAt);
      default:
        return reduceCustomDomainEvent({ event, state }) ?? state;
    }
  }

  protected override processEvent({
    blockProcessorWhile,
    event,
    previousState,
    runInBackground,
    state,
    append,
  }: Parameters<StreamProcessor<typeof ProjectProcessorContract>["processEvent"]>[0]): undefined {
    if (previousState.created) {
      runInBackground(async () => {
        try {
          await this.deps.itx.worker.processEvent({ event: event as StreamEvent });
        } catch (error) {
          console.log("project worker processEvent failed", error);
        }
      });
    }

    switch (event.type) {
      case "events.iterate.com/project/create-requested": {
        if (event.payload.projectId !== this.deps.itx.projectId) {
          throw new Error(
            `create-requested for "${event.payload.projectId}" on project "${this.deps.itx.projectId}"`,
          );
        }
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          // The root saga and the onboarding-agent birth run in parallel — each
          // is one batched append, cutting the create round-trips (see
          // tasks/os-cold-create-latency.md). The Slack webhook router is NOT
          // armed here: connection streams (/integrations/slack/{connection})
          // are born at connect time by recordSlackConnection.
          await Promise.all([
            timedStep("create-timing", timing, "root-saga-append", () =>
              append(
                buildDurableObjectProcessorSubscriptionConfiguredEvent({
                  durableObjectName: DurableObjectNameCodec.stringify({
                    projectId: this.deps.itx.projectId,
                    path: "/",
                  }),
                  processorSlug: CapabilityHostProcessorContract.slug,
                  subscriberType: "capability-host",
                }),
                {
                  type: "events.iterate.com/repo/create-requested",
                  idempotencyKey: `repo-create-requested:${this.deps.itx.projectId}:${PROJECT_REPO_PATH}`,
                  payload: {
                    path: PROJECT_REPO_PATH,
                    projectId: this.deps.itx.projectId,
                  },
                },
              ),
            ),
            // Arm the email thread router on `/integrations/email` from birth
            // (Slack routers are per-connection and armed by the connect
            // flow); the email ingress door repeats the subscription append
            // (same idempotency key) for projects born before the router
            // existed. The creator's email seeds the project sender allowlist
            // so the owner can email their project from day one without any
            // config.
            timedStep("create-timing", timing, "email-router-append", () =>
              this.deps.itx.streams.get(EMAIL_INTEGRATION_STREAM_PATH).append(
                buildDurableObjectProcessorSubscriptionConfiguredEvent({
                  durableObjectName: DurableObjectNameCodec.stringify({
                    projectId: this.deps.itx.projectId,
                    path: EMAIL_INTEGRATION_STREAM_PATH,
                  }),
                  idempotencyKey: `email-router-subscription:${this.deps.itx.projectId}`,
                  processorSlug: EmailProcessorContract.slug,
                  subscriberType: "project",
                }),
                ...(event.payload.creatorEmail === undefined
                  ? []
                  : [
                      {
                        type: "events.iterate.com/email/sender-allowed" as const,
                        idempotencyKey: `email-sender-allowed:${this.deps.itx.projectId}:${event.payload.creatorEmail.toLowerCase()}`,
                        payload: {
                          pattern: event.payload.creatorEmail,
                          reason: "project-owner",
                        },
                      },
                    ]),
              ),
            ),
            // The user can already be sitting on /agents/onboarding while repo
            // bootstrap and the project worker warm up. Birth the normal agent
            // stream immediately; the repo-created lane below repeats this with
            // the same idempotency keys as a belt-and-braces fallback.
            timedStep("create-timing", timing, "onboarding-agent-birth", () =>
              this.deps.itx.streams
                .get(ONBOARDING_AGENT_PATH)
                .append(...onboardingAgentStartEvents(this.deps)),
            ),
          ]);
        });
        break;
      }
      case "events.iterate.com/stream/child-stream-created": {
        const childPath = event.payload.childPath;
        if (
          !childPath.startsWith("/agents/") &&
          !childPath.startsWith("/secrets/") &&
          !childPath.startsWith("/scheduler/")
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          const durableObjectName = DurableObjectNameCodec.stringify({
            projectId: this.deps.itx.projectId,
            path: childPath,
          });
          if (childPath.startsWith("/scheduler/")) {
            // A scheduler stream's birth certificate is just its processor
            // subscription: the Scheduler Durable Object reduces schedules and
            // owns the alarm from the first delivered batch onward.
            await this.deps.itx.streams.get(childPath).append(
              buildDurableObjectProcessorSubscriptionConfiguredEvent({
                durableObjectName,
                idempotencyKey: `stream/subscription-configured:${durableObjectName}#${SchedulerProcessorContract.slug}`,
                processorSlug: SchedulerProcessorContract.slug,
                subscriberType: "scheduler",
              }),
            );
            return;
          }
          if (childPath.startsWith("/agents/")) {
            // The agent path picks the prompt (agentSystemPromptForPath);
            // Slack/email agents additionally get their domain processor
            // subscription.
            // Slack-agent wiring requires the full thread shape — the
            // connection segment is what replies authenticate with.
            const isSlack = slackConnectionFromAgentPath(childPath) !== null;
            await this.deps.itx.streams.get(childPath).append(
              // Identical idempotency keys to the create-time onboarding birth
              // certificate, so whichever lane runs second dedupes cleanly.
              ...agentBirthCertificateEvents({
                childPath,
                email: isEmailAgentPath(childPath),
                llmProvider: this.deps.defaultLlmProvider,
                projectId: this.deps.itx.projectId,
                slack: isSlack,
                systemPrompt: agentSystemPromptForPath(childPath),
              }),
            );
            // Every agent owns the sandbox at its own path under /sandboxes
            // (`itx.sandbox` → agentSandboxPath). Awaiting the get mints the
            // Durable Object and pins its identity durably — that IS creation;
            // no container starts here (the first command boots it, idle puts
            // it back to sleep), so agent birth stays cheap however many
            // agents a project accumulates. Non-fatal on purpose:
            // `itx.sandbox` re-ensures identity on every use, so this is eager
            // minting only — and in container-less local dev the sandbox
            // constructor throws, which must not wedge agent birth.
            await this.deps.itx.sandboxes
              .get(agentSandboxPath(childPath))
              .catch((error: unknown) => {
                console.error(`agent sandbox create failed for ${childPath}`, error);
              });
            return;
          }

          await this.deps.itx.streams.get(childPath).append(
            buildDurableObjectProcessorSubscriptionConfiguredEvent({
              durableObjectName,
              processorSlug: SecretProcessorContract.slug,
              subscriberType: "secret",
            }),
          );
        });
        return;
      }
      case "events.iterate.com/repo/created": {
        if (
          event.payload.projectId !== this.deps.itx.projectId ||
          event.payload.path !== PROJECT_REPO_PATH ||
          state.created ||
          state.createRequest === null
        ) {
          return;
        }
        blockProcessorWhile(async () => {
          const timing = { projectId: this.deps.itx.projectId };
          await timedStep("create-timing", timing, "worker-probe", () =>
            waitForDefaultProjectWorker(this.deps.itx),
          );
          await timedStep("create-timing", timing, "project-created-append", () =>
            append({
              type: "events.iterate.com/project/created",
              idempotencyKey: `project-created:${this.deps.itx.projectId}`,
              payload: state.createRequest!,
            }),
          );
          // Fallback seed for existing/retried create flows. The create-requested
          // lane normally did this already; idempotency makes the second append
          // a no-op while preserving older streams that only reach this point.
          await timedStep("create-timing", timing, "onboarding-agent-birth", () =>
            this.deps.itx.streams
              .get(ONBOARDING_AGENT_PATH)
              .append(...onboardingAgentStartEvents(this.deps)),
          );
        });
        return;
      }

      default:
        if (
          processCustomDomainEvent({
            append,
            blockProcessorWhile,
            customDomains: this.deps.customDomains,
            event,
            projectId: this.deps.itx.projectId,
            state,
          })
        ) {
          return;
        }
        return;
    }
  }
}

/** THE place the "agent path decides the reply door" rule lives: Slack thread
 * agents reply via their connection's Slack Web API, inbound MCP session agents via their blocked
 * ask_assistant call, everything else via web chat. */
function agentSystemPromptForPath(agentPath: string) {
  if (agentPath === ONBOARDING_AGENT_PATH) return ONBOARDING_AGENT_SYSTEM_PROMPT;
  const slackConnection = slackConnectionFromAgentPath(agentPath);
  if (slackConnection !== null) {
    return slackAgentSystemPrompt(slackConnection);
  }
  if (isEmailAgentPath(agentPath)) return EMAIL_AGENT_SYSTEM_PROMPT;
  if (isMcpAgentPath(agentPath)) return MCP_AGENT_SYSTEM_PROMPT;
  return DEFAULT_AGENT_SYSTEM_PROMPT;
}

function onboardingAgentStartEvents(deps: {
  defaultLlmProvider: AgentLlmProvider;
  itx: Pick<ProjectRpcTarget, "projectId">;
}) {
  return [
    ...agentBirthCertificateEvents({
      childPath: ONBOARDING_AGENT_PATH,
      llmProvider: deps.defaultLlmProvider,
      projectId: deps.itx.projectId,
      systemPrompt: ONBOARDING_AGENT_SYSTEM_PROMPT,
    }),
    {
      type: "events.iterate.com/agent/input-added" as const,
      idempotencyKey: `project-onboarding-start:${deps.itx.projectId}`,
      payload: {
        content:
          "Start onboarding now. The project owner just created this project and is looking at the chat.",
        llmRequestPolicy: { behaviour: "after-current-request" as const },
      },
    },
  ];
}

const DEFAULT_MODEL_BY_LLM_PROVIDER = {
  "cloudflare-ai": DEFAULT_AGENT_MODEL,
  "openai-ws": DEFAULT_OPENAI_WS_MODEL,
} satisfies Record<AgentLlmProvider, string>;

function agentBirthCertificateEvents(input: {
  childPath: string;
  email?: boolean;
  llmProvider: AgentLlmProvider;
  projectId: string;
  slack?: boolean;
  systemPrompt: string;
}) {
  const durableObjectName = DurableObjectNameCodec.stringify({
    projectId: input.projectId,
    path: input.childPath,
  });
  const subscription = (processorSlug: string, subscriberType: "agent" | "capability-host") =>
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${processorSlug}`,
      processorSlug,
      subscriberType,
    });
  return [
    subscription(AgentProcessorContract.slug, "agent"),
    // Both provider processors subscribe; only the one matching the agent's
    // selected llmProvider answers llm-request-requested events.
    subscription(CloudflareAiProcessorContract.slug, "agent"),
    subscription(OpenAiWsProcessorContract.slug, "agent"),
    subscription(CapabilityHostProcessorContract.slug, "capability-host"),
    ...(input.slack ? [subscription(SlackAgentProcessorContract.slug, "agent")] : []),
    ...(input.email ? [subscription(EmailAgentProcessorContract.slug, "agent")] : []),
    {
      type: "events.iterate.com/agent/config-updated" as const,
      idempotencyKey: `agent/config-updated:${input.projectId}:${input.childPath}`,
      payload: { systemPrompt: input.systemPrompt },
    },
    {
      type: "events.iterate.com/agent/llm-provider-selected" as const,
      idempotencyKey: `agent/llm-provider-selected:${input.projectId}:${input.childPath}`,
      payload: {
        ifUnset: true,
        model: DEFAULT_MODEL_BY_LLM_PROVIDER[input.llmProvider],
        provider: input.llmProvider,
      },
    },
    // The agent's own sandbox, as a provided capability on the agent's own
    // capability host — part of the birth certificate, so the mount is durable
    // and replays with the stream. A durable itx-expression, not a live mount:
    // every `itx.sandbox.<method>(...)` re-evaluates
    // `itx.sandboxes.get(/sandboxes/cloudflare<agent path>)` against the agent's own itx
    // at call time, so nothing here holds a connection or a container open.
    {
      type: "events.iterate.com/capability-host/capability-provided" as const,
      idempotencyKey: `capability-host/sandbox-provided:${input.projectId}:${input.childPath}`,
      payload: {
        path: ["sandbox"],
        type: "itx-expression" as const,
        expression: ["sandboxes", ["get", agentSandboxPath(input.childPath)]],
        instructions:
          `THIS agent's own sandbox: the container at "${agentSandboxPath(input.childPath)}" (your agent path under /sandboxes/cloudflare). ` +
          "Full Cloudflare Sandbox SDK surface (exec, readFile/writeFile, startProcess, gitCheckout, tunnels, destroy, …). " +
          "The first command boots the container; it sleeps after idle. " +
          'The project repo is ALWAYS checked out at /workspace/repos/project, also the default working directory — a bare exec("ls") lists the project.',
      },
    },
    // Per-agent boot context as a model-visible input (the system prompt is
    // static; ids and paths are not). dont-trigger-request: this must never
    // wake the LLM by itself.
    {
      type: "events.iterate.com/agent/input-added" as const,
      idempotencyKey: `agent/boot-context:${input.projectId}:${input.childPath}`,
      payload: {
        content: [
          "Platform context for this agent:",
          `- Project id: ${input.projectId}`,
          `- Your agent stream path: ${input.childPath} (your itx scope; your transcript lives here)`,
          '- The project repo is at repo path "/" — seeded during project bootstrap. On a brand-new project it may still be seeding for your first turn; if repo reads or worker calls say it is missing or not ready, keep onboarding conversational and retry shortly. Once seeded, it contains worker.ts (a static homepage + router over the apps below, plus an itx.worker.slack.* Slack SDK surface), apps/hello/worker.ts (stateless), apps/counter/worker.ts (stateful counter page), package.json (npm deps, installed at worker build time), sdk.ts (platform capability types), AGENTS.md, and ONBOARDING.md.',
          "- Read the repo with itx.repo.readFile({ path }) and itx.repo.listFiles(); change it with itx.repo.commitFiles({ message, changes: [{ path, content }] }).",
          "- Other agents live at /agents/<name> (itx.agents.list() / itx.agents.get(path)); Slack thread agents appear under /agents/slack/<connection>/<channel>/ts-<ts>; secrets under /secrets/**.",
          '- Streams are path-addressed: itx.streams.get(path).append(event) / getEvents() / waitFor(); path "/" is the project root stream.',
          '- You have your own sandbox: `itx.sandbox` is a real Linux container that is yours alone (it lives at your agent path under /sandboxes and was mounted on your scope at birth). Call it dotted: `await itx.sandbox.exec("...")`. First command boots it (allow a minute cold), it sleeps after idle. The project repo is ALWAYS checked out at /workspace/repos/project, which is also the default working directory — a bare `await itx.sandbox.exec("ls")` lists the project. The Codex CLI (`codex`, gpt-5.5/high) is preinstalled for real coding work. Expose a server publicly with a quick tunnel: `const { url } = await itx.sandbox.tunnels.get(<port>)` → an ephemeral `*.trycloudflare.com` url.',
          "- itx.__describe() lists the capabilities currently available in your scope; __describe() works on every node (itx.integrations, itx.capabilityHost, any provided capability) when you need detail.",
          '- If Google is connected, Gmail is available per connection: await itx.integrations.list() shows connections, then itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }) for inbox requests.',
        ].join("\n"),
        llmRequestPolicy: { behaviour: "dont-trigger-request" as const },
      },
    },
  ];
}

function recordStream<
  State extends {
    agents: StreamListItem[];
    repos: StreamListItem[];
    secrets: StreamListItem[];
    streams: StreamListItem[];
  },
>(state: State, path: string, createdAt: string): State {
  const item = { path, createdAt };
  return {
    ...state,
    agents: path.startsWith("/agents/") ? addStreamListItem(state.agents, item) : state.agents,
    repos:
      path === PROJECT_REPO_PATH || path.startsWith("/repos/")
        ? addStreamListItem(state.repos, item)
        : state.repos,
    secrets: path.startsWith("/secrets/") ? addStreamListItem(state.secrets, item) : state.secrets,
    streams: addStreamListItem(state.streams, item),
  };
}

function addStreamListItem(items: StreamListItem[], item: StreamListItem): StreamListItem[] {
  if (items.some((existing) => existing.path === item.path)) return items;
  return [...items, item].sort((a, b) => a.path.localeCompare(b.path));
}

async function waitForDefaultProjectWorker(itx: ProjectRpcTarget): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= PROJECT_WORKER_READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await itx.worker.fetch(new Request(PROJECT_WORKER_READY_URL));
      // This probe only cares that the project worker accepted the request. The
      // returned Response can be a Cap'n Web RPC stub, and keeping that stub
      // alive after the probe succeeds is exactly the lifecycle pattern these
      // stream tests are trying to avoid: a short-lived readiness check should
      // not retain a remote object until the whole project bootstrap session
      // ends. Dispose when the runtime supplies Symbol.dispose; local/miniflare
      // Response objects without that hook are a no-op here.
      disposeRpcResult(response);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === PROJECT_WORKER_READY_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, PROJECT_WORKER_READY_RETRY_MS));
    }
  }
  throw new Error("Default project worker did not become ready before project/created.", {
    cause: lastError,
  });
}

function disposeRpcResult(value: unknown): void {
  const dispose = (value as { [Symbol.dispose]?: () => void } | null | undefined)?.[Symbol.dispose];
  dispose?.call(value);
}
