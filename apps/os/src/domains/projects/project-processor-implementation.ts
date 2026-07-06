import { StreamProcessor } from "../streams/stream-processor.ts";
import type { EmittedInput } from "../streams/processor-contracts.ts";
import { timedStep } from "../../lib/step-timing.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { PROJECT_REPO_PATH } from "../repos/utils.ts";
import { PROJECT_REPO_INITIAL_FILES } from "../repos/project-repo-template.generated.ts";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import type { StreamEvent, StreamListItem } from "../../types.ts";
import type { ProjectRpcTarget } from "../../rpc-targets.ts";
import type { ProjectDirectoryRecord } from "../../project-directory.ts";
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
import { SecretProcessorContract } from "../secrets/secret-processor-contract.ts";
import { SlackAgentProcessorContract } from "../integrations/slack-agent-processor-contract.ts";
import { SlackProcessorContract } from "../integrations/slack-processor-contract.ts";
import { isSlackAgentPath, SLACK_INTEGRATION_STREAM_PATH } from "../integrations/utils.ts";
import { isMcpAgentPath } from "../inbound-mcp-server/mcp-session-agent-path.ts";
import type { ProjectCustomDomainCloudflareSnapshot } from "./project-processor-contract.ts";
import { ProjectProcessorContract } from "./project-processor-contract.ts";
import type { ProjectCustomDomainProvisioner } from "./custom-domains.ts";

// The onboarding script ships INSIDE the seeded repo (the agent can read the
// same file the prompt embeds); the prompt below needs its text at build time.
const PROJECT_REPO_ONBOARDING_MD = PROJECT_REPO_INITIAL_FILES.find(
  (file) => file.path === "ONBOARDING.md",
)!.content;

/**
 * Agents under `/agents/slack/**` are Slack-thread agents: the slack webhook
 * router forwards raw thread webhooks to their stream, the `slack-agent`
 * processor transcribes them, and replies go out through the itx.integrations.slack Web
 * API capability instead of web chat.
 */
export const SLACK_AGENT_SYSTEM_PROMPT = [
  "You are an iterate AI agent running inside a Slack thread.",
  "Respond with exactly one fenced JavaScript code block and no surrounding prose.",
  "The code block must contain a single async arrow function: async (itx) => { ... }.",
  "Incoming Slack webhook events arrive as your inputs. Reply only when mentioned, directly asked, or clearly needed.",
  "To reply in the thread, use await itx.integrations.slack.chat.postMessage({ channel, thread_ts, text }) with the channel and thread_ts from the incoming webhook payloads. Never use itx.chat.sendMessage for Slack replies.",
  'If asked about email, Gmail, or an inbox, use the project Google integration: first check await itx.integrations.getConnection({ provider: "google" }), then call await itx.integrations.gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }). A connected Google account gives this Slack agent Gmail access through itx.integrations.gmail; do not claim you lack inbox access before checking it.',
  "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.",
  'Keep the thread in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([itx.integrations.slack.chat.postMessage({ channel, thread_ts, text: "Checking your email now..." }), itx.integrations.gmail.request(...)]) — so the thread is never silent while you fetch.',
  "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
  "Use project capabilities on itx when they are relevant: await itx.__describe() lists them (`children` is the member map, `capabilities` the inventory) — the same __describe() works on any node, including provided capabilities. await itx.examples.list() / itx.examples.get({ id }) is a catalogue of known-good snippets.",
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

type CustomDomainDeps = ProjectCustomDomainProvisioner & {
  readProject(): Promise<ProjectDirectoryRecord | null>;
};

export class ProjectProcessor extends StreamProcessor<
  typeof ProjectProcessorContract,
  {
    /** Provider new agents are born with ("openai-ws" when the deployment has an OpenAI key). */
    defaultLlmProvider: AgentLlmProvider;
    itx: ProjectRpcTarget;
    customDomains?: CustomDomainDeps;
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
      case "events.iterate.com/project/custom-domain-add-requested":
        return upsertCustomDomain(state, {
          cloudflareHostnameId: null,
          createdAt: event.createdAt,
          error: null,
          hostname: event.payload.hostname,
          hostnameStatus: null,
          ownershipVerification: null,
          sslStatus: null,
          status: "requested",
          updatedAt: event.createdAt,
          validationRecords: [],
          wildcard: true,
        });
      case "events.iterate.com/project/custom-domain-cloudflare-observed":
        return upsertCustomDomain(state, {
          ...event.payload,
          createdAt:
            state.customDomains.find((domain) => domain.hostname === event.payload.hostname)
              ?.createdAt ?? event.createdAt,
          updatedAt: event.createdAt,
        });
      case "events.iterate.com/project/custom-domain-provision-failed":
        return upsertCustomDomain(state, {
          cloudflareHostnameId:
            state.customDomains.find((domain) => domain.hostname === event.payload.hostname)
              ?.cloudflareHostnameId ?? null,
          createdAt:
            state.customDomains.find((domain) => domain.hostname === event.payload.hostname)
              ?.createdAt ?? event.createdAt,
          error: event.payload.error,
          hostname: event.payload.hostname,
          hostnameStatus: null,
          ownershipVerification: null,
          sslStatus: null,
          status: "failed",
          updatedAt: event.createdAt,
          validationRecords: [],
          wildcard: true,
        });
      case "events.iterate.com/project/custom-domain-remove-requested":
        return markCustomDomainRemoving(state, event.payload.hostname, event.createdAt);
      case "events.iterate.com/project/custom-domain-removed":
        return {
          ...state,
          customDomains: state.customDomains.filter(
            (domain) => domain.hostname !== event.payload.hostname,
          ),
        };
      case "events.iterate.com/stream/created":
        if (event.payload.projectId !== this.deps.itx.projectId) return state;
        return recordStream(state, event.payload.path, event.createdAt);
      case "events.iterate.com/stream/child-stream-created":
        return recordStream(state, event.payload.childPath, event.createdAt);
      default:
        return state;
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
          // One atomic root append (itx subscription + repo kickoff, original
          // relative order preserved) in parallel with the independent Slack
          // stream append. The previous three sequential awaits were the
          // slowest lane of the create saga (~1.2-2.6s measured on preview-7;
          // tasks/os-cold-create-latency.md) — batching cuts it to one
          // round-trip apiece.
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
            // Arm the Slack webhook router on `/integrations/slack` from birth,
            // so a claimed workspace's first webhook routes even if the connect
            // flow's own belt-and-braces subscription append raced.
            timedStep("create-timing", timing, "slack-router-append", () =>
              this.deps.itx.streams.get(SLACK_INTEGRATION_STREAM_PATH).append(
                buildDurableObjectProcessorSubscriptionConfiguredEvent({
                  durableObjectName: DurableObjectNameCodec.stringify({
                    projectId: this.deps.itx.projectId,
                    path: SLACK_INTEGRATION_STREAM_PATH,
                  }),
                  idempotencyKey: `slack-router-subscription:${this.deps.itx.projectId}`,
                  processorSlug: SlackProcessorContract.slug,
                  subscriberType: "project",
                }),
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
      case "events.iterate.com/project/custom-domain-add-requested": {
        blockProcessorWhile(async () => {
          await appendCustomDomainObservation({
            append,
            eventOffset: event.offset,
            hostname: event.payload.hostname,
            operation: async () => {
              const customDomains = assertCustomDomainProvisioner(this.deps.customDomains);
              const project =
                (await customDomains.readProject()) ??
                projectRecordFromState(state, this.deps.itx.projectId);
              return await customDomains.ensure({ hostname: event.payload.hostname, project });
            },
            projectId: this.deps.itx.projectId,
          });
        });
        return;
      }
      case "events.iterate.com/project/custom-domain-refresh-requested": {
        blockProcessorWhile(async () => {
          await appendCustomDomainObservation({
            append,
            eventOffset: event.offset,
            hostname: event.payload.hostname,
            operation: async () => {
              const customDomains = assertCustomDomainProvisioner(this.deps.customDomains);
              const project =
                (await customDomains.readProject()) ??
                projectRecordFromState(state, this.deps.itx.projectId);
              return await customDomains.refresh({
                hostname: event.payload.hostname,
                project,
              });
            },
            projectId: this.deps.itx.projectId,
          });
        });
        return;
      }
      case "events.iterate.com/project/custom-domain-remove-requested": {
        blockProcessorWhile(async () => {
          const hostname = event.payload.hostname;
          try {
            const domain = state.customDomains.find((candidate) => candidate.hostname === hostname);
            await assertCustomDomainProvisioner(this.deps.customDomains).remove({
              cloudflareHostnameId: domain?.cloudflareHostnameId,
              hostname,
            });
            await append({
              type: "events.iterate.com/project/custom-domain-removed",
              idempotencyKey: `project/custom-domain-removed:${this.deps.itx.projectId}:${event.offset}`,
              payload: { hostname },
            });
          } catch (error) {
            await append({
              type: "events.iterate.com/project/custom-domain-provision-failed",
              idempotencyKey: `project/custom-domain-remove-failed:${this.deps.itx.projectId}:${event.offset}`,
              payload: { error: errorMessage(error), hostname },
            });
          }
        });
        return;
      }
      case "events.iterate.com/stream/child-stream-created": {
        const childPath = event.payload.childPath;
        if (!childPath.startsWith("/agents/") && !childPath.startsWith("/secrets/")) return;
        blockProcessorWhile(async () => {
          const durableObjectName = DurableObjectNameCodec.stringify({
            projectId: this.deps.itx.projectId,
            path: childPath,
          });
          if (childPath.startsWith("/agents/")) {
            // The agent path picks the prompt (agentSystemPromptForPath);
            // Slack agents additionally get the slack-agent processor
            // subscription.
            const isSlack = isSlackAgentPath(childPath);
            await this.deps.itx.streams.get(childPath).append(
              // Identical idempotency keys to the create-time onboarding birth
              // certificate, so whichever lane runs second dedupes cleanly.
              ...agentBirthCertificateEvents({
                childPath,
                llmProvider: this.deps.defaultLlmProvider,
                projectId: this.deps.itx.projectId,
                slack: isSlack,
                systemPrompt: agentSystemPromptForPath(childPath),
              }),
            );
            // Every agent owns the sandbox at its own path (`itx.sandbox`).
            // Awaiting the get mints the Durable Object and pins its identity
            // durably — that IS creation; no container starts here (the first
            // command boots it, idle puts it back to sleep), so agent birth
            // stays cheap however many agents a project accumulates. Non-fatal
            // on purpose: `itx.sandbox` re-ensures identity on every use, so
            // this is eager minting only — and in container-less local dev the
            // sandbox constructor throws, which must not wedge agent birth.
            await this.deps.itx.sandboxes.get(childPath).catch((error: unknown) => {
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
        return;
    }
  }
}

function assertCustomDomainProvisioner(
  provisioner: CustomDomainDeps | undefined,
): CustomDomainDeps {
  if (!provisioner) throw new Error("Custom-domain provisioning is not configured.");
  return provisioner;
}

function projectRecordFromState(
  state: { createRequest: { projectId: string; slug: string } | null },
  projectId: string,
): ProjectDirectoryRecord {
  const slug = state.createRequest?.slug ?? projectId;
  return { id: projectId, slug, organizationId: null, name: slug };
}

async function appendCustomDomainObservation(input: {
  append: (...input: EmittedInput<typeof ProjectProcessorContract>[]) => Promise<StreamEvent[]>;
  eventOffset: number;
  hostname: string;
  operation: () => Promise<ProjectCustomDomainCloudflareSnapshot>;
  projectId: string;
}): Promise<void> {
  try {
    const snapshot = await input.operation();
    await input.append({
      type: "events.iterate.com/project/custom-domain-cloudflare-observed",
      idempotencyKey: `project/custom-domain-observed:${input.projectId}:${input.eventOffset}`,
      payload: snapshot,
    });
  } catch (error) {
    await input.append({
      type: "events.iterate.com/project/custom-domain-provision-failed",
      idempotencyKey: `project/custom-domain-failed:${input.projectId}:${input.eventOffset}`,
      payload: { error: errorMessage(error), hostname: input.hostname },
    });
  }
}

function upsertCustomDomain<State extends { customDomains: ProjectCustomDomainState[] }>(
  state: State,
  domain: ProjectCustomDomainState,
): State {
  const next = [
    ...state.customDomains.filter((candidate) => candidate.hostname !== domain.hostname),
    domain,
  ].sort((a, b) => a.hostname.localeCompare(b.hostname));
  return { ...state, customDomains: next };
}

function markCustomDomainRemoving<State extends { customDomains: ProjectCustomDomainState[] }>(
  state: State,
  hostname: string,
  updatedAt: string,
): State {
  const domain = state.customDomains.find((candidate) => candidate.hostname === hostname);
  if (!domain) return state;
  return upsertCustomDomain(state, {
    ...domain,
    status: "removing",
    updatedAt,
  });
}

type ProjectCustomDomainState = ProjectCustomDomainCloudflareSnapshot & {
  createdAt: string;
  updatedAt: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** THE place the "agent path decides the reply door" rule lives: Slack thread
 * agents reply via itx.integrations.slack, inbound MCP session agents via their blocked
 * ask_assistant call, everything else via web chat. */
function agentSystemPromptForPath(agentPath: string) {
  if (agentPath === ONBOARDING_AGENT_PATH) return ONBOARDING_AGENT_SYSTEM_PROMPT;
  if (isSlackAgentPath(agentPath)) return SLACK_AGENT_SYSTEM_PROMPT;
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
    // `itx.sandboxes.get(<agent path>)` against the agent's own itx at call
    // time, so nothing here holds a connection or a container open.
    {
      type: "events.iterate.com/capability-host/capability-provided" as const,
      idempotencyKey: `capability-host/sandbox-provided:${input.projectId}:${input.childPath}`,
      payload: {
        path: ["sandbox"],
        type: "itx-expression" as const,
        expression: ["sandboxes", ["get", input.childPath]],
        instructions:
          `THIS agent's own sandbox: the container at the agent's own path ("${input.childPath}"). ` +
          "Full Cloudflare Sandbox SDK surface (exec, readFile/writeFile, startProcess, gitCheckout, exposePort, destroy, …). " +
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
          "- Other agents live at /agents/<name> (itx.agents.list() / itx.agents.get(path)); Slack thread agents appear under /agents/slack/<channel>/ts-<ts>; secrets under /secrets/**.",
          '- Streams are path-addressed: itx.streams.get(path).append(event) / getEvents() / waitFor(); path "/" is the project root stream.',
          '- You have your own sandbox: `itx.sandbox` is a real Linux container that is yours alone (it lives at your own agent path and was mounted on your scope at birth). Call it dotted: `await itx.sandbox.exec("...")`. First command boots it (allow a minute cold), it sleeps after idle. The project repo is ALWAYS checked out at /workspace/repos/project, which is also the default working directory — a bare `await itx.sandbox.exec("ls")` lists the project.',
          "- itx.__describe() lists the capabilities currently available in your scope; __describe() works on every node (itx.integrations, itx.capabilityHost, any provided capability) when you need detail.",
          '- If Google is connected, Gmail is available at itx.integrations.gmail. Check itx.integrations.getConnection({ provider: "google" }) and use itx.integrations.gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }) for inbox requests.',
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
