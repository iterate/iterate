// Generic agent creation policy: an existence-only birth plus the ordinary
// setup events every agent receives. Transport processors choose their own
// system-context policy explicitly; the path never decides what kind of
// processor exists on a stream.

import { AGENT_SUMMARY_UPDATED_EVENT_TYPE } from "@iterate-com/shared/agent-events";
import { z } from "zod";
import { parsePromptSections, type StreamEventInput } from "iterate/processors";
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
import { AGENT_SYSTEM_PROMPT_KEY, AgentProcessorContract } from "./agent-processor-contract.ts";

/**
 * Deterministic, synchronous content hash (djb2, hex) — the occurrence
 * identity for every shipped prompt and for birth-defaults idempotency keys.
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
 * birth-batch fallback); the template's own worker.ts publishes the same file
 * as a project birth default at runtime, so a project edits its prompt with a
 * git commit and no platform deploy. Deliberately small: it teaches the ACT
 * contract, the turn loop, the config repo, how to FIND working code, and
 * then SHOWS the surface as one annotated tour script — terse incantations
 * are safe because every call is expandable through `itx.docs` and
 * `__describe()`. agent-prompt-budgets.test.ts enforces the size ceiling.
 */
export const DEFAULT_AGENT_SYSTEM_PROMPT = embeddedTemplateFile("prompts/agent-system-prompt.md");

/**
 * Occurrence identity for every shipped prompt is its CONTENT HASH — change
 * the template file and the revision moves with it; no manual bumping, no
 * silent key collisions. The remaining numeric revisions identify exact,
 * retryable non-prompt setup occurrences: bump one whenever its shipped
 * event payload changes; the logical context key still owns supersession
 * inside the Agent projection.
 */
const DEFAULT_AGENT_SYSTEM_PROMPT_REVISION = contentHash(DEFAULT_AGENT_SYSTEM_PROMPT);
const AGENT_MODEL_POLICY_REVISION = "2";
const AGENT_WORKSPACE_POLICY_REVISION = "3";
const AGENT_BOOT_CONTEXT_REVISION = "3";

export const SLACK_AGENT_SYSTEM_PROMPT_REVISION = contentHash(
  embeddedTemplateFile("prompts/slack.md"),
);
export const TELEGRAM_AGENT_SYSTEM_PROMPT_REVISION = contentHash(
  embeddedTemplateFile("prompts/telegram.md"),
);
export const EMAIL_AGENT_SYSTEM_PROMPT_REVISION = contentHash(
  embeddedTemplateFile("prompts/email.md"),
);

type AgentSystemPromptPolicy = {
  content: string;
  /** Stable policy identity, distinct from the context slot it updates. */
  id: string;
  /** Exact shipped payload revision; bump it when `content` changes. */
  revision: string;
};

/**
 * Agents under `/agents/slack/**` are Slack-thread agents: the slack webhook
 * router forwards raw thread webhooks to their stream, the `slack-agent`
 * processor transcribes them, and replies go out through the named Slack
 * connection's itx.integrations.slack.get(connection) Web API capability instead
 * of web chat. The router passes that connection explicitly when it creates
 * the Slack facet; the path is only the stream's address.
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
 * chat. The router passes the connection and chat id explicitly when it
 * creates the Telegram facet; the path is only the stream's address.
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
 * reply door is the same itx.chat.sendMessage as web chat.
 */
export const MCP_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "You are serving this project's MCP server. Your messages come from an AI agent (an MCP client) acting on behalf of the project owner, through the ask_assistant MCP tool. That tool call blocks until your next itx.chat.sendMessage reply and returns it verbatim to the asking agent.",
  "This overrides the multi-message chat and every-turn progress-update guidance above: send NO acknowledgements or progress updates — the first sendMessage ends the caller's wait, so it must BE the complete answer. Reply exactly once per request with await itx.chat.sendMessage(message). Do the requested work directly with your capabilities; only ask a clarifying question when the request is genuinely ambiguous.",
].join("\n");
export const MCP_AGENT_SYSTEM_PROMPT_REVISION = contentHash(MCP_AGENT_SYSTEM_PROMPT);

/**
 * One exact, retryable occurrence establishing the agent's system prompt as
 * STANDING SECTIONS: the sectionized prompt file is parsed here, at append
 * time (structure at append; fold ops never parse model-visible strings).
 * A tagged file becomes one section per `<section id>`; untagged content —
 * including whole untagged files, the integration channel prompts — becomes
 * the one umbrella `agent/system-prompt` section, whose presence (like any
 * prompt-file section's) makes the agent ready: the processor holds LLM
 * triggers until the birth prompt stands. `idempotencyKey` identifies this
 * payload occurrence; never reuse one after changing `content`.
 */
export function agentSystemPromptContextEvent(input: { content: string; idempotencyKey: string }) {
  return AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: input.idempotencyKey,
    payload: {
      role: "system",
      content: "",
      segments: parsePromptSections({
        content: input.content,
        fallbackKey: AGENT_SYSTEM_PROMPT_KEY,
      }),
    },
  });
}

/** The `agent/created` payload — the agent's birth certificate (a loose
 * object of caller-authored birth facts; `{}` is the norm). */
export type AgentCreateInput = z.input<
  (typeof AgentProcessorContract.events)["events.iterate.com/agent/created"]["payloadSchema"]
>;

/** The initial debounce for agents whose first turn should wait for the
 * project's config worker. Deliberately RIDICULOUSLY generous: a first-ever
 * worker build occasionally blew through 10s in preview, and a wrong-dialect
 * first turn costs more than a slow one — a dead worker still leaves a
 * usable (platform-default) agent after this window. The worker lowers it
 * to the ordinary 250ms as its done-configuring signal, which also releases
 * any held first turn immediately — see llmRequestDebounceMs in the
 * contract. Tighten once cold-build latency is optimised. */
export const AGENT_INITIAL_DEBOUNCE_MS = 60_000;

const AGENT_BIRTH_CONFIG_REVISION = "1";

/**
 * Build the complete creation batch for one agent stream. Every agent has the
 * same agent + capability-host pair; a router may add one explicitly named
 * sibling processor and its birth certificate. The stream path remains only
 * an address and never selects a processor.
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
  /**
   * Human-facing project facts from the directory, when the caller has them:
   * the very first question a real user asked their agent was "which project
   * is this?", and an opaque prj_ hex id was the only answer the boot
   * context could give. Optional because some hosts (tests, bare births)
   * have no directory at hand — the id-only line still works.
   */
  project?: { name: string; slug: string; workerUrl?: string };
  /** Initial execution policy for a routed agent. */
  systemPromptPolicy?: AgentSystemPromptPolicy;
  /**
   * Whether this batch is committing a BRAND-NEW agent (the caller probed
   * the stream — see AgentRpcTarget.create) whose first turn should wait
   * for the project's config worker: true adds the birth-config event
   * (parsing on, debounce AGENT_INITIAL_DEBOUNCE_MS). False for re-creates
   * over existing agents — a late high-debounce event would overwrite the
   * worker's lowered value — and for integration routers, whose agents
   * carry explicit prompts at birth and keep the ordinary debounce.
   */
  highInitialDebounce: boolean;
  sibling?: {
    birthCertificate: SiblingBirthCertificate;
    /** The sibling's subscription name — the sibling contract's slug. */
    name: string;
  };
}) {
  const { agentPath, projectId, project } = input;
  // The platform default model IS the contract's config default — parsing the
  // empty config surfaces it without a second constant that could drift.
  const model = AgentProcessorContract.stateSchema.shape.config.parse({}).llm.model;
  const systemPromptPolicy: AgentSystemPromptPolicy = input.systemPromptPolicy ?? {
    content: DEFAULT_AGENT_SYSTEM_PROMPT,
    id: "default",
    revision: DEFAULT_AGENT_SYSTEM_PROMPT_REVISION,
  };
  const systemPrompt = systemPromptPolicy.content;
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
  const configured = AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agent/configured",
    idempotencyKey: `agent/model-configured:v${AGENT_MODEL_POLICY_REVISION}:${projectId}:${agentPath}`,
    payload: { config: { llm: { model } } },
  });
  // The birth config, explicit on the stream (not a schema default): the
  // parsing flag spelled out, and the high initial debounce that gives the
  // project's config worker its window before the first turn. NEWBORN
  // streams only — this event must never land on an agent whose worker
  // already lowered the debounce (see the highInitialDebounce input doc).
  const birthConfig = input.highInitialDebounce
    ? [
        AgentProcessorContract.buildEvent({
          type: "events.iterate.com/agent/configured",
          idempotencyKey: `agent/birth-config:v${AGENT_BIRTH_CONFIG_REVISION}:${projectId}:${agentPath}`,
          payload: {
            config: {
              interpretResponses: true,
              llmRequestDebounceMs: AGENT_INITIAL_DEBOUNCE_MS,
            },
          },
        }),
      ]
    : [];
  const systemPromptContext = agentSystemPromptContextEvent({
    content: systemPrompt,
    // "segments" (and the v2) in the prefix on purpose: the event BODY
    // changed shape when prompts became keyed segments (and again when the
    // segment field spelling settled on `key`), while an unchanged prompt
    // file keeps the same revision — a re-create over an agent born under
    // the older shape must append a fresh superseding occurrence, not trip
    // same-key-different-body.
    idempotencyKey: `agent/system-prompt-segments:v2:${systemPromptPolicy.id}:v${systemPromptPolicy.revision}:${projectId}:${agentPath}`,
  });
  const bootContext = AgentProcessorContract.buildEvent({
    // Per-agent boot context as a second durable system item: ids and paths
    // differ per agent but must survive history compaction. Facts and pointers
    // only — everything per-capability is discoverable through itx.docs /
    // __describe, so this must not grow back into a capability tour (the
    // prompt budget test holds the line). System context never wakes the LLM
    // by itself.
    type: "events.iterate.com/agents/context-added",
    // The body embeds directory-derived project facts, so the occurrence
    // identity must carry them too: a create replayed after the directory
    // record changed (or with facts where a router birth had none) appends a
    // fresh superseding occurrence in the same keyed slot instead of tripping
    // the stream's same-key-different-body rejection. Fact-less births keep
    // the bare key, so router replays dedupe exactly as before.
    idempotencyKey: `agent/boot-system-context:v${AGENT_BOOT_CONTEXT_REVISION}:${projectId}:${agentPath}${
      project === undefined
        ? ""
        : `:${JSON.stringify([project.name, project.slug, project.workerUrl ?? null])}`
    }`,
    payload: {
      role: "system",
      key: "agent/boot-context",
      content: [
        "Context for this agent:",
        project === undefined
          ? `- Project id: ${projectId}`
          : `- Project: ${JSON.stringify(project.name)} (slug ${project.slug}, id ${projectId})${project.workerUrl === undefined ? "" : ` — the project worker/website serves ${project.workerUrl}`}`,
        `- Your agent stream path: ${agentPath} (your itx scope; your transcript lives here)`,
        `- Your workspace directory: ${agentWorkspacePath(agentPath)} — private scratch; relative workspace paths resolve there. Every project repo is mounted in your workspace at its own path.`,
        // One seed list, marked non-exhaustive, and ONE rule for choosing
        // between the two write doors — the model was repeating this line
        // verbatim to users as the repo's full contents.
        '- The project config repo is at "/repos/config" (itx.repo), seeded with worker.ts (the project worker + website), AGENTS.md, package.json, and more. On a brand-new project it may still be seeding on your first turn — if repo or worker calls say it is missing or not ready, retry shortly instead of treating that as fatal.',
        '- Two write doors, one rule: itx.repo.commitFiles({ message, changes }) (repo-relative paths) for a small direct edit; your private workspace (itx.workspace — workspace paths like "/repos/config/worker.ts": readFile/writeFile/edit/glob) when you want to read and change several files before shipping ONE commit via itx.workspace.git.commit({ message, scope: "/repos/config" }). Both land straight on main and redeploy the project worker/website — no branches, no push.',
        "- Delegate explicitly: const child = itx.agents.get('researcher'); await child.create(); await child.message(task) — put everything the child needs in the message, then end your turn; its report arrives as your input.",
        // Deliberate reinforcement of the prompt's FIND WORKING CODE
        // section — repetition is the one thing small prompts buy back.
        '- FIRST MOVE for an unfamiliar API: await itx.docs.search({ q: "several related words" }) — working example scripts, type declarations, and this project\'s mounted capabilities; each hit carries a fetchCall string, the ready-made itx.docs.get call that fetches its full doc. await itx.__describe() lists everything at your scope.',
      ].join("\n"),
    },
  });
  const agentSubscription = buildFacetProcessorSubscriptionConfiguredEvent({
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
    systemPrompt,
    model,
    events: [
      birthCertificate,
      ...(input.initialEvents ?? []),
      capabilityHostBirthCertificate,
      ...siblingBirthCertificates,
      configured,
      ...birthConfig,
      systemPromptContext,
      workspaceProvided,
      bootContext,
      agentSubscription,
      capabilityHostSubscription,
      collectionSubscription,
      ...siblingSubscriptions,
    ],
  };
}
