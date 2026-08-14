// Generic agent creation policy: an existence-only birth plus the ordinary
// setup events every agent receives. Transport processors choose their own
// system-context policy explicitly; the path never decides what kind of
// processor exists on a stream.

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
 * The default codemode system prompt for web-chat agents (child agents, MCP
 * session agents, and the onboarding agent build on it), sourced from the
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

// The onboarding script ships INSIDE the seeded repo (the agent can read the
// same file the prompt embeds); the prompt below needs its text at build time.
const PROJECT_REPO_ONBOARDING_MD = PROJECT_REPO_INITIAL_FILES.find(
  (file) => file.path === "ONBOARDING.md",
)!.content;

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
 * The onboarding agent is a normal web-chat agent whose system prompt embeds
 * the seeded ONBOARDING.md script. Same codemode contract as every agent.
 */
export const ONBOARDING_AGENT_SYSTEM_PROMPT = [
  DEFAULT_AGENT_SYSTEM_PROMPT,
  "",
  "You are this project's onboarding agent. Follow the onboarding script below.",
  "On a brand-new project, the project repo and worker may still be seeding during your first turn. If a repo or worker capability reports that it is missing or not ready, keep onboarding conversational and retry shortly instead of treating that as a fatal setup failure.",
  "",
  PROJECT_REPO_ONBOARDING_MD,
].join("\n");
export const ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION = contentHash(ONBOARDING_AGENT_SYSTEM_PROMPT);

/**
 * One exact, retryable occurrence updating the agent runtime's keyed
 * system-context slot. `idempotencyKey` identifies this payload occurrence;
 * the context key identifies the logical slot and makes a later revision
 * supersede it. Never reuse an idempotency key after changing `content`.
 */
export function agentSystemPromptContextEvent(input: { content: string; idempotencyKey: string }) {
  return AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agents/context-added",
    idempotencyKey: input.idempotencyKey,
    payload: {
      role: "system",
      // The one logical system-context slot whose presence makes an agent
      // ready — the processor holds LLM triggers until it exists.
      key: "agent/system-prompt",
      content: input.content,
    },
  });
}

/** The `agent/created` payload — the agent's birth certificate (a loose
 * object of caller-authored birth facts; `{}` is the norm). */
export type AgentCreateInput = z.input<
  (typeof AgentProcessorContract.events)["events.iterate.com/agent/created"]["payloadSchema"]
>;

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
/**
 * PROJECT-LEVEL AGENT BIRTH DEFAULTS — the format-agnostic door that makes
 * the agent processor swappable in userland WITHOUT a race: a project
 * publishes this value under the AGENT_BIRTH_DEFAULTS_KEY of its generic
 * defaults store (`project/defaults-configured`, latest occurrence wins per
 * key), and the agent-creation door folds it into every birth batch — so an
 * agent is BORN with the chosen driver, prompt, and processor subscriptions
 * instead of being converted a delivery-hop after its first turn already
 * started. The project stores the value opaquely; THIS schema and the
 * vocabulary check run at the door's read site, and the platform never
 * learns what any of it means. Explicit per-call policies (integration
 * routers' systemPromptPolicy) always win over project defaults.
 */
/** The agents domain's key in the project's generic defaults store
 * (`project/defaults-configured` → `state.defaults[key]`). The project holds
 * the value opaquely; THIS domain parses it (AgentBirthDefaults +
 * validateAgentBirthEvents) at the creation door's read site. */
export const AGENT_BIRTH_DEFAULTS_KEY = "agents/birth-defaults";

export const AgentBirthDefaults = z.object({
  /** Which agents these defaults apply to. Absent = every agent born through
   * the generic creation door. */
  matches: z.object({ pathPrefix: z.string().trim().min(1) }).optional(),
  /**
   * The project's contribution to every matching birth batch, as PLAIN
   * EVENTS: a prompt is a keyed `agents/context-added`, a driver choice an
   * `agent/configured`, a processor attachment a
   * `stream/subscription-configured`. No per-field plumbing — the next
   * defaultable thing needs zero platform changes. Validated by
   * `validateAgentBirthEvents` (agent-consumed vocabulary plus a tight
   * platform-lane allowlist); idempotency keys are platform-minted with the
   * content in the key, so changed defaults supersede replay-safely and a
   * project can never wedge creates with hand-rolled keys.
   */
  birthEvents: z
    .array(
      z.object({
        type: z.string().trim().min(1),
        payload: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(20),
});
export type AgentBirthDefaults = z.infer<typeof AgentBirthDefaults>;

/** Platform-lane items a project may include beyond the agent-consumed
 * vocabulary: attaching a registered agent-family processor. Everything else
 * platform-lane stays platform-authored. */
const BIRTH_DEFAULTS_SUBSCRIPTION_ALLOWLIST = new Set<string>(["agent-headless"]);

/**
 * Validate one defaults value's birth events. Returns ok or an error string —
 * the caller (the creation door's read of the project's generic defaults
 * store) treats any error as "no defaults", never as a creation failure:
 * malformed userland data must degrade to platform-default births.
 */
export function validateAgentBirthEvents(
  birthEvents: AgentBirthDefaults["birthEvents"],
): { ok: true } | { ok: false; error: string } {
  for (const [index, event] of birthEvents.entries()) {
    if (event.type === "events.iterate.com/stream/subscription-configured") {
      // The FULL payload schema first: anything that would fail the stream's
      // own validation must be rejected HERE, where it degrades to
      // platform-default births — inside the atomic birth append it would
      // break every matching create() instead.
      const payloadCheck = CoreProcessorContract.events[
        "events.iterate.com/stream/subscription-configured"
      ].payloadSchema.safeParse(event.payload);
      if (!payloadCheck.success) {
        return {
          ok: false,
          error: `birthEvents[${index}]: invalid subscription-configured payload: ${payloadCheck.error.message}`,
        };
      }
      // Then the gate: a BUILTIN facet processor under an allowlisted
      // agent-family name — a userspace source would run arbitrary worker
      // code under the allowlisted name.
      const subscription = z
        .looseObject({
          name: z.string(),
          receiver: z.looseObject({
            action: z.literal("facet-processor"),
            source: z.looseObject({ kind: z.literal("builtin") }),
          }),
        })
        .safeParse(event.payload);
      if (!subscription.success) {
        return {
          ok: false,
          error: `birthEvents[${index}]: only builtin facet-processor subscriptions may ride a birth batch`,
        };
      }
      if (!BIRTH_DEFAULTS_SUBSCRIPTION_ALLOWLIST.has(subscription.data.name)) {
        return {
          ok: false,
          error: `birthEvents[${index}]: subscription name ${JSON.stringify(subscription.data.name)} is not an allowlisted agent-family processor`,
        };
      }
      continue;
    }
    try {
      // parseConsumedInput's input type is the typed consumed-event union so
      // AUTHORED appends catch typos at compile time; this callsite is the
      // other use — runtime validation of untrusted data, where the cast
      // exists purely to hand the parser something to accept or reject.
      AgentProcessorContract.parseConsumedInput({
        type: event.type,
        ...(event.payload === undefined ? {} : { payload: event.payload }),
      } as never);
    } catch (error) {
      return {
        ok: false,
        error: `birthEvents[${index}] (${event.type}): ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { ok: true };
}

/** Deterministic, synchronous content hash for defaults idempotency keys —
 * djb2 over the JSON form; collision-tolerant because the full content also
 * rides the batch and same-key-different-body appends are rejected. */
function hashAgentBirthDefaults(birthEvents: AgentBirthDefaults["birthEvents"]): string {
  return contentHash(JSON.stringify(birthEvents));
}

export function agentCreationForPath<
  const SiblingBirthCertificate extends StreamEventInput = never,
  const InitialEvent extends StreamEventInput = never,
  const Defaults extends AgentBirthDefaults | undefined = undefined,
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
  /** Project-level birth defaults (see AgentBirthDefaults): validated plain
   * events folded into the batch. An explicit systemPromptPolicy wins over
   * any prompt-slot event in the list. */
  defaults?: Defaults;
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
  // Project birth defaults: validated plain events appended into the batch
  // with platform-minted content-hash keys. Invalid lists degrade to
  // platform-default births (warn, never fail creation). An explicit
  // systemPromptPolicy outranks the project: prompt-slot events are dropped
  // from the list; otherwise a project prompt-slot event REPLACES the
  // platform fallback below.
  const rawBirthEvents = input.defaults?.birthEvents ?? [];
  const birthEventsCheck =
    rawBirthEvents.length === 0
      ? ({ ok: true } as const)
      : validateAgentBirthEvents(rawBirthEvents);
  if (!birthEventsCheck.ok) {
    console.warn("[agent] ignoring invalid agent birth defaults", {
      agentPath,
      error: birthEventsCheck.error,
    });
  }
  const isPromptSlotEvent = (candidate: { type: string; payload?: Record<string, unknown> }) =>
    candidate.type === "events.iterate.com/agents/context-added" &&
    candidate.payload?.role === "system" &&
    candidate.payload?.key === "agent/system-prompt";
  const birthEvents = (birthEventsCheck.ok ? rawBirthEvents : []).filter(
    (candidate) => input.systemPromptPolicy === undefined || !isPromptSlotEvent(candidate),
  );
  const defaultsCarryPrompt = birthEvents.some(isPromptSlotEvent);
  const birthEventsHash = hashAgentBirthDefaults(birthEvents);
  // Userland events cannot carry static types — but callers that never pass
  // `defaults` (the integration routers, whose creation events must satisfy
  // their contracts' emit vocabularies) should not have their events union
  // widened by a branch that is empty for them. `never[]` when no defaults
  // were passed; plain StreamEventInput otherwise (runtime-validated above).
  const defaultsEvents = birthEvents.map((candidate, index) => ({
    type: candidate.type,
    payload: candidate.payload ?? {},
    idempotencyKey: `agent/birth-defaults:${birthEventsHash}:${index}:${projectId}:${agentPath}`,
  })) as unknown as [Defaults] extends [undefined] ? never[] : StreamEventInput[];

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
  const systemPromptContext = agentSystemPromptContextEvent({
    content: systemPrompt,
    idempotencyKey: `agent/system-prompt:${systemPromptPolicy.id}:v${systemPromptPolicy.revision}:${projectId}:${agentPath}`,
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
      // The fallback prompt slot is skipped when the project's defaults carry
      // their own prompt-slot event (single prompt per birth); an explicit
      // systemPromptPolicy already filtered those out above.
      ...(defaultsCarryPrompt ? [] : [systemPromptContext]),
      workspaceProvided,
      bootContext,
      agentSubscription,
      capabilityHostSubscription,
      collectionSubscription,
      ...siblingSubscriptions,
      // Project defaults LAST: keyed occurrences supersede platform slots.
      ...defaultsEvents,
    ],
  };
}
