// Generic agent creation policy: an existence-only birth plus the ordinary
// setup MECHANISM every agent receives (capability host, workspace,
// subscriptions). Personality — prompt, model choice, standing context — is
// authored by the project's config worker AFTER birth, reacting to
// `agent/created` in processEvent and appending `agent/birth-finalized` when
// done; `defaultAgentBirthEvents` below is the platform-default personality
// it can start from (served as plain events through
// itx.agents.get(path).getDefaultBirthEvents). The path never decides what
// kind of processor exists on a stream.

import { AGENT_SUMMARY_UPDATED_EVENT_TYPE } from "@iterate-com/shared/agent-events";
import { z } from "zod";
import type { StreamEventInput } from "iterate/processors";
import { PROJECT_REPO_INITIAL_FILES } from "../repos/config-repo-template.generated.ts";
import { buildFacetProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { agentWorkspacePath } from "../workspaces/utils.ts";
import { CapabilityHostProcessorContract } from "../capability-host/capability-host-processor-contract.ts";
import { capabilityHostCreationEvents } from "../capability-host/capability-host-defaults.ts";
import {
  AGENT_COLLECTION_CREATED_EVENT_TYPE,
  AGENT_COLLECTION_PATH,
  AGENT_COLLECTION_SUBSCRIPTION_NAME,
  AgentCollectionProcessorContract,
} from "./agent-collection-processor-contract.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";

/**
 * Deterministic, synchronous content hash (djb2, hex) — the occurrence
 * identity for every shipped prompt and platform-default birth event.
 * Collision-tolerant because the full content also rides the keyed event and
 * same-key-different-body appends are rejected.
 */
function contentHash(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * One embedded config-repo template file (the platform's build-time copy of
 * `configs/default`, the same map that seeds every new project repo). The
 * trailing newline every checked-in file carries is not part of the content
 * the platform ships in events.
 */
function embeddedTemplateFile(path: string): string {
  const file = PROJECT_REPO_INITIAL_FILES.find((candidate) => candidate.path === path);
  if (file === undefined) throw new Error(`missing embedded config template file: ${path}`);
  return file.content.replace(/\n$/, "");
}

/** Fill a prompt template's `{{placeholder}}` slots; loud on leftovers so a
 * template/interpolator drift fails tests instead of shipping a literal
 * `{{postMessage}}` to a model. */
function interpolatePromptTemplate(template: string, values: Record<string, string>): string {
  let content = template;
  for (const [key, value] of Object.entries(values)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  const leftover = content.match(/\{\{\w+\}\}/);
  if (leftover !== null) throw new Error(`unfilled prompt template placeholder: ${leftover[0]}`);
  return content;
}

/**
 * The complete atomic birth batch for the project's singleton agent-collection
 * stream (`/agents`): the existence marker plus the subscription arming its
 * facet-hosted projection processor. Previously appended by the (retired)
 * AgentCollectionDurableObject's constructor on first dial; now every agent
 * `create()` ensures it — the idempotency keys make retries free.
 */
export function agentCollectionCreationEvents(input: { projectId: string }) {
  return [
    AgentCollectionProcessorContract.buildEvent({
      type: AGENT_COLLECTION_CREATED_EVENT_TYPE,
      idempotencyKey: `agent-collection/created:${input.projectId}`,
      payload: {},
    }),
    buildFacetProcessorSubscriptionConfiguredEvent({
      idempotencyKey: `stream/subscription-configured:${AgentCollectionProcessorContract.slug}`,
      name: AgentCollectionProcessorContract.slug,
    }),
  ];
}

export const AGENT_SUMMARY_INSTRUCTION = [
  "AGENT SUMMARY (mandatory) — append alongside your work:",
  "```ts",
  "// FIRST TURN: set title and initial activity.",
  "await Promise.all([",
  "  itx.agent.append({",
  '    type: "events.iterate.com/agent/summary-updated",',
  '    payload: { title: "Short specific title", activity: "Starting work" },',
  "  }),",
  "  // other work you are doing",
  "]);",
  "",
  "// SECOND TURN: update activity; do so again when the phase changes.",
  "await Promise.all([",
  "  itx.agent.append({",
  '    type: "events.iterate.com/agent/summary-updated",',
  '    payload: { activity: "What you are doing now" },',
  "  }),",
  "  // other work you are doing",
  "]);",
  "",
  "// WHEN RETURNING NO VALUE / WAITING FOR USER:",
  "await Promise.all([",
  "  itx.agent.append({",
  '    type: "events.iterate.com/agent/summary-updated",',
  '    payload: { waitingFor: "user_input" },',
  "  }),",
  "  // send your reply through this channel's reply API",
  "]);",
  "return;",
  "```",
  'Combine waitingFor with first/second-turn fields when needed. Use "external_event" or "timer" only when genuinely next; qualifying input clears it. Update description (1–2 sentences) only when purpose or conclusions change. Never set pinned unless asked.',
].join("\n");

/**
 * The default codemode system prompt for web-chat agents (child agents, MCP,
 * and session agents build on it), sourced from the
 * config-repo template file `prompts/agent-system-prompt.md` — the ONE home
 * for its text. The platform reads the build-time embedded copy here (the
 * getDefaultBirthEvents / degraded-start fallback); a project edits its
 * prompt by having its config worker author a different keyed prompt event
 * at birth — a git commit, no platform deploy. Deliberately small: it
 * teaches the ACT contract, the turn loop, the config repo, how to FIND
 * working code, and then SHOWS the surface as one annotated tour script —
 * terse incantations are safe because every call is expandable through
 * `itx.docs` and `__describe()`. agent-prompt-budgets.test.ts enforces the
 * size ceiling.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = embeddedTemplateFile("prompts/agent-system-prompt.md");

/**
 * Agents under `/agents/slack/**` are Slack-thread agents: the slack webhook
 * router forwards raw thread webhooks to their stream, the `slack-agent`
 * processor transcribes them, and replies go out through the named Slack
 * connection's itx.integrations.slack.get(connection) Web API capability instead
 * of web chat. The router records that connection in the birth certificate's
 * channel facts; the path is only the stream's address.
 */
export function slackAgentSystemPrompt(connection: string): string {
  return interpolatePromptTemplate(embeddedTemplateFile("prompts/slack.md"), {
    agentSummaryInstruction: AGENT_SUMMARY_INSTRUCTION,
    postMessage: `itx.integrations.slack.get(${JSON.stringify(connection)}).chat.postMessage`,
  });
}

/**
 * Agents under `/agents/telegram/**` are Telegram-chat agents: the telegram
 * webhook router forwards raw chat updates to their stream (one stream per
 * chat SESSION — `/new` rotates to a fresh one), the `telegram-agent`
 * processor transcribes them, and replies go out through the journaled send
 * pair (`telegram/send-requested` appended to the session stream → the
 * processor delivers it and marks `telegram/message-sent`) instead of web
 * chat. The router records the connection and chat id in the birth
 * certificate's channel facts; the path is only the stream's address.
 */
export function telegramAgentSystemPrompt(input: {
  agentPath: string;
  chatId: string | null;
  connection: string;
}): string {
  return interpolatePromptTemplate(embeddedTemplateFile("prompts/telegram.md"), {
    agentPathJson: JSON.stringify(input.agentPath),
    agentSummaryInstruction: AGENT_SUMMARY_INSTRUCTION,
    chatIdNote: input.chatId === null ? "" : ` (this chat's id is ${input.chatId})`,
    telegramConnection: `itx.integrations.telegram.get(${JSON.stringify(input.connection)})`,
  });
}

/**
 * Agents under `/agents/email/**` are email-thread agents: the email router
 * forwards inbound mail to their stream, the `email-agent` processor
 * transcribes it, and replies go out through itx.email.reply — which derives
 * the counterpart, subject, and threading headers from the thread stream.
 */
export const EMAIL_AGENT_SYSTEM_PROMPT = interpolatePromptTemplate(
  embeddedTemplateFile("prompts/email.md"),
  { agentSummaryInstruction: AGENT_SUMMARY_INSTRUCTION },
);

/**
 * Agents under `/agents/mcp/**` are inbound MCP session agents: one stream per
 * inbound MCP session. The ask_assistant MCP tool appends the caller's message
 * to the session stream and blocks until the agent's next chat reply, so the
 * replies go through the same itx.chat.sendMessage as web chat.
 */
export const MCP_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "You are serving this project's MCP server. Your messages come from an AI agent (an MCP client) acting on behalf of the project owner, through the ask_assistant MCP tool. That tool call blocks until your next itx.chat.sendMessage reply and returns it verbatim to the asking agent.",
  "This overrides the multi-message chat and every-turn progress-update guidance above: send NO acknowledgements or progress updates — the first sendMessage ends the caller's wait, so it must BE the complete answer. Reply exactly once per request with await itx.chat.sendMessage(message). Do the requested work directly with your capabilities; only ask a clarifying question when the request is genuinely ambiguous.",
].join("\n");

/** The `agent/created` payload — the agent's birth certificate (a loose
 * object of caller-authored birth facts; `{}` is the norm). */
export type AgentCreateInput = z.input<
  (typeof AgentProcessorContract.events)["events.iterate.com/agent/created"]["payloadSchema"]
>;

// -----------------------------------------------------------------------------
// The platform-default personality, as plain events.
// -----------------------------------------------------------------------------

/**
 * Which platform-default personality `getDefaultBirthEvents` serves. `web`
 * and `onboarding` share the default web-chat prompt (onboarding's extra
 * instructions are the template worker's own context appends); `mcp` layers
 * the ask_assistant reply contract on top; the channel kinds interpolate
 * their prompts from the birth certificate's channel facts.
 */
export const AgentBirthKind = z.enum(["web", "onboarding", "mcp", "slack", "telegram", "email"]);
/** Which platform-default personality `getDefaultBirthEvents` serves — the
 * web/onboarding default prompt, the MCP reply contract, or a channel prompt
 * interpolated from the birth certificate's channel facts. */
export type AgentBirthKind = z.infer<typeof AgentBirthKind>;

/**
 * Channel facts an integration router records in the `agent/created` birth
 * certificate (under the `channel` key) when it creates the agent core —
 * everything the default personality needs to interpolate a channel prompt.
 * Loose on purpose: routers may record more facts than the prompts read.
 */
const AgentChannelFacts = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("slack"), connection: z.string().min(1) }),
  z.looseObject({
    type: z.literal("telegram"),
    connection: z.string().min(1),
    chatId: z.string().min(1).optional(),
  }),
  z.looseObject({ type: z.literal("email") }),
]);
type AgentChannelFacts = z.infer<typeof AgentChannelFacts>;

/**
 * The platform-default personality for one agent, as PLAIN KEYED EVENTS —
 * the implementation behind `itx.agents.get(path).getDefaultBirthEvents({kind})`,
 * and (kind `web`, coordinates omitted) the degraded-start batch the turn
 * loop appends when a project's config worker misses the readiness deadline.
 *
 * Every event's idempotency key embeds a content hash, so the two callers
 * converge: a late worker appending the same default events after a degraded
 * start dedupes on identical keys instead of conflicting, and a worker
 * shipping DIFFERENT content lands a superseding occurrence in the same
 * logical context slot (`key`). The events deliberately do NOT include
 * `agent/birth-finalized` — finalizing is the author's own statement that it
 * is done.
 */
export function defaultAgentBirthEvents(input: {
  kind: AgentBirthKind;
  /**
   * The agent's own coordinates — the rpc service passes them (plus
   * directory-derived project facts) and gets the boot-context item too; the
   * degraded-start turn loop lacks them and gets personality-only events.
   */
  coordinates?: {
    agentPath: string;
    projectId: string;
    project?: { name: string; slug: string; workerUrl?: string };
  };
  /** The agent/created birth certificate payload (channel facts for the
   * channel kinds). */
  birthCertificate?: Record<string, unknown>;
}) {
  const systemPrompt = defaultSystemPromptForKind(input);
  // The platform default model IS the contract's config default — parsing the
  // empty config surfaces it without a second constant that could drift.
  const model = AgentProcessorContract.stateSchema.shape.config.parse({}).llm.model;
  const promptEvent = AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: `agent/default-birth:prompt:${input.kind}:${contentHash(systemPrompt)}`,
    payload: {
      role: "system",
      // The one logical system-prompt slot: a worker's own prompt event with
      // the same key supersedes this occurrence in place (or appends a newer
      // occurrence once a request covered it).
      key: "agent/system-prompt",
      content: systemPrompt,
    },
  });
  const modelEvent = AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agent/configured",
    idempotencyKey: `agent/default-birth:model:${contentHash(model)}`,
    payload: { config: { llm: { model } } },
  });
  const coordinates = input.coordinates;
  if (coordinates === undefined) return [promptEvent, modelEvent];
  const bootContent = agentBootContextContent(coordinates);
  const bootContextEvent = AgentProcessorContract.buildEvent({
    // Per-agent boot context as a second durable system item: ids and paths
    // differ per agent but must survive history compaction. Facts and pointers
    // only — everything per-capability is discoverable through itx.docs /
    // __describe, so this must not grow back into a capability tour (the
    // prompt budget test holds the line). System context never wakes the LLM
    // by itself.
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: `agent/default-birth:boot-context:${contentHash(bootContent)}`,
    payload: {
      role: "system",
      key: "agent/boot-context",
      content: bootContent,
    },
  });
  return [promptEvent, modelEvent, bootContextEvent];
}

/** The kind → prompt selection, interpolating channel facts where the kind
 * needs them. Loud when a channel kind lacks its facts: the caller (the
 * config worker's birth job) should fail visibly and let the platform's
 * degraded-start deadline cover the held turn, never ship a silently
 * mis-addressed personality. */
function defaultSystemPromptForKind(input: {
  kind: AgentBirthKind;
  coordinates?: { agentPath: string };
  birthCertificate?: Record<string, unknown>;
}): string {
  switch (input.kind) {
    case "web":
    case "onboarding":
      return DEFAULT_AGENT_SYSTEM_PROMPT;
    case "mcp":
      return MCP_AGENT_SYSTEM_PROMPT;
    case "email":
      return EMAIL_AGENT_SYSTEM_PROMPT;
    case "slack": {
      const facts = parseChannelFacts(input.birthCertificate, "slack");
      return slackAgentSystemPrompt(facts.connection);
    }
    case "telegram": {
      const facts = parseChannelFacts(input.birthCertificate, "telegram");
      if (input.coordinates === undefined) {
        throw new Error("telegram default birth events need the agent's coordinates");
      }
      return telegramAgentSystemPrompt({
        agentPath: input.coordinates.agentPath,
        chatId: facts.chatId ?? null,
        connection: facts.connection,
      });
    }
  }
}

function parseChannelFacts<Kind extends AgentChannelFacts["type"]>(
  birthCertificate: Record<string, unknown> | undefined,
  kind: Kind,
): Extract<AgentChannelFacts, { type: Kind }> {
  const parsed = AgentChannelFacts.safeParse(birthCertificate?.channel);
  if (!parsed.success || parsed.data.type !== kind) {
    throw new Error(
      `${kind} default birth events need channel facts in the birth certificate: ` +
        `agent/created payload { channel: { type: ${JSON.stringify(kind)}, ... } }` +
        (parsed.success ? ` (found ${JSON.stringify(parsed.data.type)})` : ""),
    );
  }
  return parsed.data as Extract<AgentChannelFacts, { type: Kind }>;
}

/** The boot-context system item's content: which project this is, where the
 * agent lives, and the handful of standing pointers every agent needs. */
function agentBootContextContent(coordinates: {
  agentPath: string;
  projectId: string;
  project?: { name: string; slug: string; workerUrl?: string };
}): string {
  const { agentPath, projectId, project } = coordinates;
  return [
    "Context for this agent:",
    project === undefined
      ? `- Project id: ${projectId}`
      : `- Project: ${JSON.stringify(project.name)} (slug ${project.slug}, id ${projectId})${project.workerUrl === undefined ? "" : ` — the project worker/website serves ${project.workerUrl}`}`,
    `- Your agent stream path: ${agentPath} (your itx scope; your transcript lives here)`,
    `- Your workspace directory: ${agentWorkspacePath(agentPath)} — private scratch; relative workspace paths resolve there. Every project repo is mounted in your workspace at its own path.`,
    // One seed list, marked non-exhaustive, and ONE rule for choosing
    // between the two write methods — the model was repeating this line
    // verbatim to users as the repo's full contents.
    '- The project config repo is at "/repos/config" (itx.repo), seeded with worker.ts (the project worker + website), AGENTS.md, package.json, and more. On a brand-new project it may still be seeding on your first turn — if repo or worker calls say it is missing or not ready, retry shortly instead of treating that as fatal.',
    '- Two ways to write, one rule: itx.repo.commitFiles({ message, changes }) (repo-relative paths) for a small direct edit; your private workspace (itx.workspace — workspace paths like "/repos/config/worker.ts": readFile/writeFile/edit/glob) when you want to read and change several files before shipping ONE commit via itx.workspace.git.commit({ message, scope: "/repos/config" }). Both land straight on main and redeploy the project worker/website — no branches, no push.',
    "- Delegate explicitly: const child = itx.agents.get('researcher'); await child.create(); await child.message(task) — put everything the child needs in the message, then end your turn; its report arrives as your input.",
    // Deliberate reinforcement of the prompt's FIND WORKING CODE
    // section — repetition is the one thing small prompts buy back.
    '- FIRST MOVE for an unfamiliar API: await itx.docs.search({ q: "several related words" }) — working example scripts, type declarations, and this project\'s mounted capabilities; each hit carries a fetchCall string, the ready-made itx.docs.get call that fetches its full doc. await itx.__describe() lists everything at your scope.',
  ].join("\n");
}

// -----------------------------------------------------------------------------
// The creation core.
// -----------------------------------------------------------------------------

/** Exact, retryable occurrence identity for the workspace capability mount:
 * bump it whenever the shipped event payload changes. */
const AGENT_WORKSPACE_POLICY_REVISION = "3";

/**
 * Build the complete creation batch for one agent stream — the atomic CORE
 * and nothing else: the `agent/created` birth certificate, the capability
 * host pair, the workspace capability, the agent processor subscription (`agent`),
 * the collection copy, and any explicitly named sibling.
 * No prompt, no model choice, no boot context: personality is authored by
 * the project's config worker reacting to `agent/created` (finalized with
 * `agent/birth-finalized`), and the agent processor holds LLM triggers until it does.
 *
 * The created event's idempotency key is payload-free on purpose: a repeated
 * create with the identical payload dedupes and resolves, while a create over
 * an EXISTING agent with a different payload is rejected by the stream's
 * same-key-different-body rule — the loud duplicate-create failure.
 */
export function agentCreationForPath<
  const SiblingBirthCertificate extends StreamEventInput = never,
  const InitialEvent extends StreamEventInput = never,
>(input: {
  agentPath: string;
  projectId: string;
  /** The `agent/created` birth certificate payload. Defaults to `{}`. */
  payload?: AgentCreateInput;
  /** Events that must commit in the same creation batch. */
  initialEvents?: readonly InitialEvent[];
  sibling?: {
    birthCertificate: SiblingBirthCertificate;
    /** The sibling's subscription name — the sibling contract's slug. */
    name: string;
  };
}) {
  const { agentPath, projectId } = input;
  const birthCertificate = AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agent/created",
    idempotencyKey: `agent/created:${projectId}:${agentPath}`,
    payload: input.payload ?? {},
  });
  // The agent's own capability scope: the shared capability-host birth batch
  // (created + processor subscription), with the default one-hop fallback to
  // the project root host journaled at birth — no path walking.
  const [capabilityHostBirthCertificate, capabilityHostSubscription] = capabilityHostCreationEvents(
    {
      path: agentPath,
      projectId,
    },
  );
  const workspaceProvided = CapabilityHostProcessorContract.buildEvent({
    // The agent's own workspace, a durable itx-expression re-evaluated per
    // call. AgentRpcTarget.create explicitly births that addressed workspace
    // before returning the agent handle. (No sandbox mount: sandboxes are
    // pets, created explicitly via itx.sandboxes.get(path).create.)
    type: "events.iterate.com/capability-host/capability-provided",
    idempotencyKey: `capability-host/workspace-provided:v${AGENT_WORKSPACE_POLICY_REVISION}:${projectId}:${agentPath}`,
    payload: {
      path: ["workspace"],
      type: "itx-call",
      expression: ["workspaces", ["get", agentWorkspacePath(agentPath)]],
      instructions:
        `THIS agent's own workspace — your private working copy of the project's one path namespace: a mount-routed, copy-on-write filesystem living in a Durable Object (no container, no clone, always warm). Every project repo is mounted at its own path — the config repo at "/repos/config", any repo at its "/repos/<name>", freshly created repos just appear. Reads see each repo's latest main until you shadow a path; writes/edits/deletes stay private until committed (readFile/writeFile/edit/glob/listAllFiles). Paths are absolute and fully qualified; RELATIVE paths resolve to your own directory "${agentWorkspacePath(agentPath)}" — private scratch, never committable, not visible to anyone else. ` +
        'To ship changes: await itx.workspace.git.commit({ message, scope: "/repos/<name>" }) — ONE repo\'s changes become a commit straight on ITS main branch (config-repo commits redeploy the project worker/website automatically; no branches, no push). scope is required whenever more than one repo is dirty. Deviate a mount via getConfig/configure (e.g. { policy: "read-only" } on reference clones).',
    },
  });
  const processorSubscription = buildFacetProcessorSubscriptionConfiguredEvent({
    idempotencyKey: `stream/subscription-configured:${AgentProcessorContract.slug}`,
    name: AgentProcessorContract.slug,
  });
  const collectionSubscription = CoreProcessorContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream/subscription-configured:${AGENT_COLLECTION_SUBSCRIPTION_NAME}`,
    payload: {
      name: AGENT_COLLECTION_SUBSCRIPTION_NAME,
      description: "Project agent collection projection",
      filter: {
        eventTypes: ["events.iterate.com/agent/created", AGENT_SUMMARY_UPDATED_EVENT_TYPE],
      },
      receiver: {
        action: "copy-to-stream",
        receivingStreamPath: AGENT_COLLECTION_PATH,
        delivery: {
          // The subscription is configured in the same birth batch as created.
          start: "beginning",
          onFailingEvent: "halt",
        },
      },
    },
  });
  const siblingBirthCertificates: SiblingBirthCertificate[] =
    input.sibling === undefined ? [] : [input.sibling.birthCertificate];
  const siblingSubscriptions =
    input.sibling === undefined
      ? []
      : [
          buildFacetProcessorSubscriptionConfiguredEvent({
            idempotencyKey: `stream/subscription-configured:${input.sibling.name}`,
            name: input.sibling.name,
          }),
        ];

  return {
    birthCertificate,
    events: [
      birthCertificate,
      ...(input.initialEvents ?? []),
      capabilityHostBirthCertificate,
      ...siblingBirthCertificates,
      workspaceProvided,
      processorSubscription,
      capabilityHostSubscription,
      collectionSubscription,
      ...siblingSubscriptions,
    ],
  };
}
