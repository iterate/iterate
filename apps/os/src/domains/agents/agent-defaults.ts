// Generic agent creation policy: an existence-only birth plus the ordinary
// setup events every agent receives. Transport processors choose their own
// system-context policy explicitly; the path never decides what kind of
// processor exists on a stream.

import { AGENT_SUMMARY_UPDATED_EVENT_TYPE } from "@iterate-com/shared/agent-events";
import type { StreamEventInput } from "iterate/processors";
import { PROJECT_REPO_INITIAL_FILES } from "../repos/config-repo-template.generated.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { CoreProcessorContract } from "../streams/core-processor-contract.ts";
import { agentWorkspacePath } from "../workspaces/utils.ts";
import {
  CapabilityHostProcessorContract,
  capabilityFallbackForScope,
} from "../capability-host/capability-host-processor-contract.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import {
  AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
  AGENT_SUMMARY_INSTRUCTION,
  AgentProcessorContract,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_SYSTEM_PROMPT,
} from "./agent-processor-contract.ts";

const TYPESCRIPT_FENCE_INSTRUCTION =
  "Respond with exactly one fenced TypeScript code block opened with ```ts and no surrounding prose.";

/**
 * These revisions identify exact, retryable setup occurrences. Change the
 * matching revision whenever the shipped event payload changes; the logical
 * context key still owns supersession inside the Agent projection.
 */
const DEFAULT_AGENT_SYSTEM_PROMPT_REVISION = "3";
const AGENT_MODEL_POLICY_REVISION = "1";
const AGENT_WORKSPACE_POLICY_REVISION = "2";
const AGENT_BOOT_CONTEXT_REVISION = "2";

export const SLACK_AGENT_SYSTEM_PROMPT_REVISION = "2";
export const TELEGRAM_AGENT_SYSTEM_PROMPT_REVISION = "2";
export const EMAIL_AGENT_SYSTEM_PROMPT_REVISION = "2";
// The MCP and onboarding prompts EMBED the default prompt, so their event
// bodies change whenever it does — their occurrence identity must move with
// every constituent revision, or an existing stream rejects the re-append as
// a different body under a reused key. The own component still covers their
// own extension text (onboarding: also PROJECT_REPO_ONBOARDING_MD).
export const MCP_AGENT_SYSTEM_PROMPT_REVISION = `1.${DEFAULT_AGENT_SYSTEM_PROMPT_REVISION}`;
export const ONBOARDING_AGENT_SYSTEM_PROMPT_REVISION = `1.${DEFAULT_AGENT_SYSTEM_PROMPT_REVISION}`;

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
  const postMessage = `itx.integrations.slack.get(${JSON.stringify(connection)}).chat.postMessage`;
  return [
    "You are an iterate AI agent running inside a Slack thread.",
    TYPESCRIPT_FENCE_INSTRUCTION,
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "SILENCE IS THE DEFAULT. The platform only wakes you when someone @mentions you (or Slack delivers app_mention), and on later messages in a thread where you were already mentioned. Prefer doing nothing: if the latest message is not clearly directed at you, return undefined without posting. Do not chime in on human-to-human chatter, ambient channel noise, or messages aimed at other bots. When in doubt, stay silent — every unnecessary reply costs money and interrupts people.",
    `To reply in the thread, use await ${postMessage}({ channel, thread_ts, text }) with the channel and thread_ts from the incoming webhook payloads. Never use itx.chat.sendMessage for Slack replies.`,
    "FILES people share in the thread are downloaded into project file storage and attached to your inputs automatically: images are directly visible to you; other formats carry a hint line telling you how to read them: fetch bytes via itx.files.get(path).bytes(), then convert documents to markdown with const [converted] = await itx.ai.toMarkdown([{ name, blob: new Blob([bytes]) }]) — supports PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, and XML.",
    `To SEND a file or image to the thread — including ones you generate with itx.ai.run (image models return base64 in response.image) — store it and post its signed url; Slack unfurls image urls into inline previews. NEVER paste base64 into message text: const stored = await itx.agent.addFiles({ files: [{ filename: "cat.png", contentType: "image/png", data: response.image }], llmRequestPolicy: { behaviour: "dont-trigger-request" } }); await ${postMessage}({ channel, thread_ts, text: "Here you go! " + stored.files[0].url }); Stored images also stay visible to you on later turns, so you can iterate on what you made.`,
    'If someone posts a URL to an image you need to look at, download it and attach it to your conversation so you can actually see it: const resp = await fetch(url); await itx.agent.addFiles({ files: [{ filename: "photo.jpg", contentType: resp.headers.get("content-type") ?? "application/octet-stream", data: await resp.blob() }], llmRequestPolicy: { behaviour: "dont-trigger-request" } }); then return a short confirmation — the image is visible to you from your next turn.',
    'If asked about email, Gmail, or an inbox: use await itx.integrations.gmail.get().request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }). Pass a connection slug to get(...) only when a specific Google account matters. Do not claim you lack inbox access before checking.',
    'If asked about GitHub, use `const octokit = itx.integrations.github.get().octokit`; this 99% path selects the first connected installation. Only inspect `await itx.integrations.list()` and pass its connection slug to `get(slug)` when a particular installation matters. `octokit` is the all-in-one client from the `octokit` package, with Iterate supplying installation auth and transport: use `octokit.rest.*` for routine endpoints or `octokit.graphql(query, variables)` when GraphQL is a better fit. Use the package types and https://github.com/octokit/octokit.js/; there is no direct `.rest` or `.graphql` on the connection. GitHub repo.data.permissions is a user-style view and can report every flag false for a GitHub App installation that can write; never call the installation read-only from that field—attempt the requested operation and use GitHub\'s actual error if denied. Known-good snippets: itx.docs.get({ name: "github-list-repos" }) and itx.docs.get({ name: "github-read-file" }).',
    "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.",
    `Keep the thread in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([${postMessage}({ channel, thread_ts, text: "Checking your email now..." }), itx.integrations.gmail.get().request(...)]) — so the thread is never silent while you fetch.`,
    AGENT_SUMMARY_INSTRUCTION,
    "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
    `To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: "async (itx, schedule, trigger) => { ... }" }) — the script is a STRING run later with full project access; to have it post back to this thread, bake the channel and thread_ts into it and call ${postMessage}. itx.scheduler.list() / cancel(key) manage schedules.`,
    'Use project capabilities on itx when they are relevant. TWO SEARCHES, ONE RULE — HOW: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities (word-overlap matching — synonyms buy recall; await itx.docs.get({ name }) fetches one). WHAT/WHEN: await itx.search.query({ q }) searches everything this project has accumulated — conversations, webhooks, events, files, repo — and every hit carries a ref back to the exact source; search before paging streams. await itx.__describe() works on every node, including provided capabilities.',
  ].join("\n");
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
  const telegramConnection = `itx.integrations.telegram.get(${JSON.stringify(input.connection)})`;
  const chatIdNote = input.chatId === null ? "" : ` (this chat's id is ${input.chatId})`;
  const sendRequest = (streamPath: string, text: string) =>
    `itx.streams.get(${JSON.stringify(streamPath)}).append({ type: "events.iterate.com/telegram/send-requested", payload: { text: ${text} } })`;
  return [
    "You are an iterate AI agent running inside a Telegram chat.",
    TYPESCRIPT_FENCE_INSTRUCTION,
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "Incoming Telegram webhook updates arrive as your inputs (message text, sender, chat).",
    `To reply in the chat, append a SEND REQUEST to your own stream — it is delivered reliably and recorded in this thread's journal: await ${sendRequest(input.agentPath, '"..."')}. The payload is a plain Bot API sendMessage body: chat_id${chatIdNote} is set for you and ALWAYS this stream's chat (to message a different chat, use the raw sendMessage call below instead); other sendMessage params (parse_mode, reply_to_message_id, ...) can ride along in the payload. Never use itx.chat.sendMessage for Telegram replies.`,
    `THREADS: this stream is one conversation session — /new from the user rotates the chat to a fresh session stream. When an input carries a reply-hint note (the user REPLIED to a message from a different thread, its stream path is in the note), or the user references earlier conversation you don't have, READ the referenced thread FIRST — before any repo/workspace exploration: await itx.streams.get(path).getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] }). Those two event types ARE the transcript (user text in payload.body.message.text, your replies in payload.text); do NOT call getEvents unfiltered — the first page is subscriber/llm plumbing, not conversation — and if exactly 500 events come back, page with afterOffset: events.at(-1).offset to reach the recent end. Only then answer: INTO that thread by appending your send request to that stream instead of your own, or here — your judgement. No reply-hint and no idea which session? Search instead of paging: await itx.search.query({ q: <what the user referenced>, source: "streams" }) — hits carry a ref to the exact events.`,
    `For any other Bot API call (sendPhoto, sendDocument, editMessageText, answerCallbackQuery, …) use ${telegramConnection}.<method>(params) with ONE params object (https://core.telegram.org/bots/api) — these are immediate calls, not journaled sends, so pass chat_id yourself.`,
    'Messages are plain text by default. For formatting pass parse_mode: "HTML" with simple tags (<b>, <i>, <code>, <pre>, <a href>) — Telegram does NOT render markdown headings or tables, so prefer short plain-text replies.',
    "v1 limitation: photos/voice/stickers people send arrive only as bracketed placeholders like [photo] — you cannot view them yet; say so if asked about one.",
    "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.",
    `Keep the chat in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([${sendRequest(input.agentPath, '"Checking that now..."')}, itx.mcp.exa.web_search_exa({ query })]) — so the chat is never silent while you fetch.`,
    AGENT_SUMMARY_INSTRUCTION,
    "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
    `To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: "async (itx, schedule, trigger) => { ... }" }) — the script is a STRING run later with full project access; to have it post back to this chat, bake the chat_id into it and call ${telegramConnection}.sendMessage (scheduled scripts outlive sessions, so use the direct call there, not a session send request). itx.scheduler.list() / cancel(key) manage schedules.`,
    'Use project capabilities on itx when they are relevant. TWO SEARCHES, ONE RULE — HOW: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities (word-overlap matching — synonyms buy recall; await itx.docs.get({ name }) fetches one). WHAT/WHEN: await itx.search.query({ q }) searches everything this project has accumulated — conversations, webhooks, events, files, repo — and every hit carries a ref back to the exact source; search before paging streams. await itx.__describe() works on every node, including provided capabilities.',
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
  TYPESCRIPT_FENCE_INSTRUCTION,
  "The code block must contain a single async arrow function: async (itx) => { ... }.",
  "Inbound emails on this thread arrive as your inputs (from, subject, body, attachments).",
  "To answer, use await itx.email.reply({ text }) (or { html }). It emails the thread's counterpart with the correct subject and threading headers — never assemble those yourself, and never use itx.chat.sendMessage or itx.email.send to answer this thread.",
  "ATTACHMENTS people email you are stored in project file storage and attached to your inputs automatically: images (png/jpeg/webp/svg) are directly visible to you — just look at them. Documents are NOT directly readable; convert them to markdown first with Cloudflare's converter: const bytes = await itx.files.get(path).bytes(); const [converted] = await itx.ai.toMarkdown([{ name: filename, blob: new Blob([bytes]) }]); converted.data is the markdown. Supported formats: PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, XML, and images. The stored `path` for each attachment is in your input's file list.",
  'To attach files when replying (PDFs, images, any type): store bytes as a project file first (await itx.files.get("/email/report.pdf").put({ data, contentType })), then reply({ text, attachments: [{ path: "/email/report.pdf" }] }). Limits: 32 files, 5 MiB total per email.',
  "Email is not chat: one complete, well-written reply per inbound message. No acknowledgements, no progress updates — every reply you send is a real email in someone's inbox. Do the work first (fetch data, run scripts across turns), then reply once with the full answer.",
  AGENT_SUMMARY_INSTRUCTION,
  "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply.",
  "Write emails like a thoughtful human colleague: plain text by default, greeting and sign-off optional and brief, no markdown formatting (it is not rendered in email).",
  "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
  'Use project capabilities on itx when they are relevant. TWO SEARCHES, ONE RULE — HOW: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities (word-overlap matching — synonyms buy recall; await itx.docs.get({ name }) fetches one). WHAT/WHEN: await itx.search.query({ q }) searches everything this project has accumulated — conversations, webhooks, events, files, repo — and every hit carries a ref back to the exact source; search before paging streams. await itx.__describe() works on every node, including provided capabilities.',
].join("\n");

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
      key: AGENT_SYSTEM_PROMPT_CONTEXT_KEY,
      content: input.content,
    },
  });
}

/**
 * Build the complete creation batch for one agent stream. Every agent has the
 * same agent + capability-host pair; a router may add one explicitly named
 * sibling processor and its birth certificate. The stream path remains only
 * an address and never selects a processor.
 */
export function agentCreationForPath<
  const SiblingBirthCertificate extends StreamEventInput = never,
  const InitialEvent extends StreamEventInput = never,
>(input: {
  agentPath: string;
  projectId: string;
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
  sibling?: {
    birthCertificate: SiblingBirthCertificate;
    processorSlug: string;
  };
}) {
  const { agentPath, projectId, project } = input;
  const model = DEFAULT_AGENT_MODEL;
  const systemPromptPolicy: AgentSystemPromptPolicy = input.systemPromptPolicy ?? {
    content: DEFAULT_AGENT_SYSTEM_PROMPT,
    id: "default",
    revision: DEFAULT_AGENT_SYSTEM_PROMPT_REVISION,
  };
  const systemPrompt = systemPromptPolicy.content;

  const birthCertificate = AgentProcessorContract.buildEvent({
    type: "events.iterate.com/agent/created",
    idempotencyKey: `agent/created:${projectId}:${agentPath}`,
    payload: {},
  });
  const capabilityHostBirthCertificate = CapabilityHostProcessorContract.buildEvent({
    type: "events.iterate.com/capability-host/created",
    idempotencyKey: `capability-host/created:${projectId}:${agentPath}`,
    // A capability miss at the agent's scope re-resolves directly at the
    // project root host — one hop, journaled at birth, no path walking.
    payload: { config: {}, fallback: capabilityFallbackForScope(agentPath) },
  });
  const workspaceProvided = CapabilityHostProcessorContract.buildEvent({
    // The agent's own workspace, a durable itx-expression re-evaluated per
    // call, so agent birth never touches the workspace Durable Object. (No
    // sandbox mount: sandboxes are pets, created explicitly via
    // itx.sandboxes.create.)
    type: "events.iterate.com/capability-host/capability-provided",
    idempotencyKey: `capability-host/workspace-provided:v${AGENT_WORKSPACE_POLICY_REVISION}:${projectId}:${agentPath}`,
    payload: {
      path: ["workspace"],
      type: "itx-expression",
      expression: ["workspaces", ["get", agentWorkspacePath(agentPath)]],
      instructions:
        `THIS agent's own workspace at "${agentWorkspacePath(agentPath)}" (your agent path under /workspaces): a mount-routed, copy-on-write filesystem living in a Durable Object — no container, no clone, always warm. By default the config repo is mounted at "/", so reads see its latest main until you shadow a path; writes/edits/deletes stay private until committed (readFile/writeFile/edit/glob/listAllFiles; paths are absolute). ` +
        "To ship your changes: await itx.workspace.git.commit({ message }) — that commits them straight to the mounted repo's MAIN branch and the project worker/website redeploys automatically. No branches, no push, no other steps. " +
        "More repos can be mounted into the tree (getConfig/configure: mount path → { repoPath, policy }); commits route per mount and never span mounts (pass { scope } when more than one mount is dirty).",
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
    idempotencyKey: `agent/boot-system-context:v${AGENT_BOOT_CONTEXT_REVISION}:${projectId}:${agentPath}`,
    payload: {
      role: "system",
      key: "agent/boot-context",
      content: [
        "Context for this agent:",
        project === undefined
          ? `- Project id: ${projectId}`
          : `- Project: ${JSON.stringify(project.name)} (slug ${project.slug}, id ${projectId})${project.workerUrl === undefined ? "" : ` — the project worker/website serves ${project.workerUrl}`}`,
        `- Your agent stream path: ${agentPath} (your itx scope; your transcript lives here)`,
        // One seed list, marked non-exhaustive, and ONE rule for choosing
        // between the two write doors — the model was repeating this line
        // verbatim to users as the repo's full contents.
        '- The project config repo is at "/repos/config" (itx.repo), seeded with worker.ts (the project worker + website), AGENTS.md, package.json, and more. On a brand-new project it may still be seeding on your first turn — if repo or worker calls say it is missing or not ready, retry shortly instead of treating that as fatal.',
        '- Two write doors, one rule: itx.repo.commitFiles({ message, changes }) for a small direct edit; your private workspace (itx.workspace — the config repo mounted at "/", live at latest main: readFile/writeFile/edit/glob) when you want to read and change several files before shipping ONE commit via itx.workspace.git.commit({ message }). Both land straight on main and redeploy the project worker/website — no branches, no push.',
        "- Delegate explicitly: const child = itx.agents.get('researcher'); await child.create(); await child.message(task) — put everything the child needs in the message, then end your turn; its report arrives as your input.",
        // Deliberate reinforcement of the prompt's FIND WORKING CODE
        // section — repetition is the one thing small prompts buy back.
        '- FIRST MOVE for an unfamiliar API: await itx.docs.search({ q: "several related words" }) — working example scripts, type declarations, and this project\'s mounted capabilities; each hit carries a fetchCall string, the ready-made itx.docs.get call that fetches its full doc. For unfamiliar PROJECT facts or history: await itx.search.query({ q }) — conversations, webhooks, events, files, and the repo are all indexed, and each hit carries a ref back to the exact source. Noisy results? Refine the query (drop filler words, quote exact tokens); do not fall back to paging vendor APIs. await itx.__describe() lists everything at your scope.',
      ].join("\n"),
    },
  });
  const durableObjectName = DurableObjectNameCodec.stringify({ projectId, path: agentPath });
  const agentSubscription = buildDurableObjectProcessorSubscriptionConfiguredEvent({
    durableObjectName,
    idempotencyKey: `stream/subscription-configured:${durableObjectName}#${AgentProcessorContract.slug}`,
    processor: ["agents", ["get", agentPath], "processor"],
    processorSlug: AgentProcessorContract.slug,
  });
  const capabilityHostSubscription = buildDurableObjectProcessorSubscriptionConfiguredEvent({
    durableObjectName,
    idempotencyKey: `stream/subscription-configured:${durableObjectName}#${CapabilityHostProcessorContract.slug}`,
    processor: ["capabilityHosts", ["get", agentPath], "processor"],
    processorSlug: CapabilityHostProcessorContract.slug,
  });
  const collectionSubscription = CoreProcessorContract.buildEvent({
    type: "events.iterate.com/stream/subscription-configured",
    idempotencyKey: `stream/subscription-configured:${durableObjectName}#agent-collection`,
    payload: {
      subscriptionKey: "agent-collection",
      description: "Project agent collection projection",
      selector: {
        eventTypes: ["events.iterate.com/agent/created", AGENT_SUMMARY_UPDATED_EVENT_TYPE],
      },
      delivery: { mode: "push", expression: ["agents", "processEvent"] },
      // The subscription is configured in the same birth batch as created.
      deliver: "all",
    },
  });
  const siblingBirthCertificates: SiblingBirthCertificate[] =
    input.sibling === undefined ? [] : [input.sibling.birthCertificate];
  const siblingSubscriptions =
    input.sibling === undefined
      ? []
      : [
          buildDurableObjectProcessorSubscriptionConfiguredEvent({
            durableObjectName,
            idempotencyKey: `stream/subscription-configured:${durableObjectName}#${input.sibling.processorSlug}`,
            processor: ["agents", ["get", agentPath], "processor"],
            processorSlug: input.sibling.processorSlug,
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
