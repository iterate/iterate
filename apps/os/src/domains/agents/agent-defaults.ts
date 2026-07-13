// The platform's default agent POLICY, as data: which system prompt, model,
// provider, capability mounts, and boot context a new agent gets, decided by
// its path. This module is the single source both consumers share:
//
//   - `itx.agents.defaults.forPath(path)` (rpc-targets.ts) hands the policy to
//     the project worker, which owns appending it — the seeded template reacts
//     to `stream/child-stream-created` for `/agents/**` and appends
//     `defaults.events` (see config-repo-template/worker.ts). Projects bend
//     policy by editing that reaction, not by forking the platform.
//   - The project processor appends only MECHANICS (processor subscriptions);
//     it no longer touches policy.
//
// Every event carries an idempotency key derived from (projectId, agentPath),
// so at-least-once delivery to the worker and retried creates all collapse
// into one durable birth certificate.

import { PROJECT_REPO_INITIAL_FILES } from "../repos/config-repo-template.generated.ts";
import { ONBOARDING_AGENT_PATH } from "../../lib/onboarding-agent.ts";
import { childAgentParentPath } from "../../lib/agent-paths.ts";
import { agentWorkspacePath } from "../workspaces/utils.ts";
import {
  slackConnectionFromAgentPath,
  telegramChatIdFromAgentPath,
  telegramConnectionFromAgentPath,
} from "../integrations/utils.ts";
import { isEmailAgentPath } from "../email/utils.ts";
import {
  GithubAgentConfiguration,
  type GithubAgentConfigurationInput,
} from "../repos/github-agent-processor-contract.ts";
import { isGithubAgentPath } from "../repos/github-agent-utils.ts";
import { isMcpAgentPath } from "../inbound-mcp-server/mcp-session-agent-path.ts";
import { DEFAULT_AGENT_MODEL, DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-processor-contract.ts";

const TYPESCRIPT_FENCE_INSTRUCTION =
  "Respond with exactly one fenced TypeScript code block opened with ```ts and no surrounding prose.";

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
    TYPESCRIPT_FENCE_INSTRUCTION,
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "Incoming Slack webhook events arrive as your inputs. Reply only when mentioned, directly asked, or clearly needed.",
    `To reply in the thread, use await ${postMessage}({ channel, thread_ts, text }) with the channel and thread_ts from the incoming webhook payloads. Never use itx.chat.sendMessage for Slack replies.`,
    "FILES people share in the thread are downloaded into project file storage and attached to your inputs automatically: images are directly visible to you; other formats carry a hint line telling you how to read them: fetch bytes via itx.files.get(path).bytes(), then convert documents to markdown with const [converted] = await itx.ai.toMarkdown([{ name, blob: new Blob([bytes]) }]) — supports PDF (.pdf), spreadsheets (.xlsx/.xlsm/.xlsb/.xls/.csv/.ods/.numbers), Word documents (.docx/.odt), HTML, and XML.",
    `To SEND a file or image to the thread — including ones you generate with itx.ai.run (image models return base64 in response.image) — store it and post its signed url; Slack unfurls image urls into inline previews. NEVER paste base64 into message text: const stored = await itx.agent.addFiles({ files: [{ filename: "cat.png", contentType: "image/png", data: response.image }], llmRequestPolicy: { behaviour: "dont-trigger-request" } }); await ${postMessage}({ channel, thread_ts, text: "Here you go! " + stored.files[0].url }); Stored images also stay visible to you on later turns, so you can iterate on what you made.`,
    'If someone posts a URL to an image you need to look at, download it and attach it to your conversation so you can actually see it: const resp = await fetch(url); await itx.agent.addFiles({ files: [{ filename: "photo.jpg", contentType: resp.headers.get("content-type") ?? "application/octet-stream", data: await resp.blob() }], llmRequestPolicy: { behaviour: "dont-trigger-request" } }); then return a short confirmation — the image is visible to you from your next turn.',
    'If asked about email, Gmail, or an inbox: await itx.integrations.list() shows the project\'s connections; a connected Google connection gives Gmail access via await itx.integrations.google["<connection>"].gmail.request({ path: "/users/me/messages", query: { maxResults: 10, q: "in:inbox" } }). Do not claim you lack inbox access before checking.',
    'If asked about GitHub, find the connection with itx.integrations.list(). Its `.octokit` property is the ordinary Octokit from `@octokit/rest`, with Iterate supplying installation auth and transport: itx.integrations.github["<connection>"].octokit.rest.... Use the package types and https://octokit.github.io/rest.js/; there is no direct `.rest` on the connection. Known-good snippets: itx.docs.get({ name: "github-list-repos" }) and itx.docs.get({ name: "github-read-file" }).',
    "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.",
    `Keep the thread in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([${postMessage}({ channel, thread_ts, text: "Checking your email now..." }), itx.integrations.google["<connection>"].gmail.request(...)]) — so the thread is never silent while you fetch.`,
    "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
    `To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: "async (itx, schedule, trigger) => { ... }" }) — the script is a STRING run later with full project access; to have it post back to this thread, bake the channel and thread_ts into it and call ${postMessage}. itx.scheduler.list() / cancel(key) manage schedules.`,
    'Use project capabilities on itx when they are relevant. FIND WORKING CODE FIRST: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities — matching is dumb word overlap, so more synonyms means better recall; await itx.docs.get({ name }) fetches one. await itx.__describe() works on every node, including provided capabilities.',
  ].join("\n");
}

/**
 * Agents under `/agents/telegram/**` are Telegram-chat agents: the telegram
 * webhook router forwards raw chat updates to their stream (one stream per
 * chat SESSION — `/new` rotates to a fresh one), the `telegram-agent`
 * processor transcribes them, and replies go out through the journaled send
 * pair (`telegram/send-requested` appended to the session stream → the
 * processor delivers it and marks `telegram/message-sent`) instead of web
 * chat. The connection and chat id come from the agent's path
 * (`/agents/telegram/{connection}/chat-{chatId}[/session-{unixSeconds}]`).
 */
export function telegramAgentSystemPrompt(input: {
  agentPath: string;
  chatId: string | null;
  connection: string;
}): string {
  const telegramConnection = `itx.integrations.telegram[${JSON.stringify(input.connection)}]`;
  const chatIdNote = input.chatId === null ? "" : ` (this chat's id is ${input.chatId})`;
  const sendRequest = (streamPath: string, text: string) =>
    `itx.streams.get(${JSON.stringify(streamPath)}).append({ type: "events.iterate.com/telegram/send-requested", payload: { text: ${text} } })`;
  return [
    "You are an iterate AI agent running inside a Telegram chat.",
    TYPESCRIPT_FENCE_INSTRUCTION,
    "The code block must contain a single async arrow function: async (itx) => { ... }.",
    "Incoming Telegram webhook updates arrive as your inputs (message text, sender, chat).",
    `To reply in the chat, append a SEND REQUEST to your own stream — it is delivered reliably and recorded in this thread's journal: await ${sendRequest(input.agentPath, '"..."')}. The payload is a plain Bot API sendMessage body: chat_id${chatIdNote} is set for you and ALWAYS this stream's chat (to message a different chat, use the raw sendMessage call below instead); other sendMessage params (parse_mode, reply_to_message_id, ...) can ride along in the payload. Never use itx.chat.sendMessage for Telegram replies.`,
    `THREADS: this stream is one conversation session — /new from the user rotates the chat to a fresh session stream. When an input carries a reply-hint note (the user REPLIED to a message from a different thread, its stream path is in the note), or the user references earlier conversation you don't have, READ the referenced thread FIRST — before any repo/workspace exploration: await itx.streams.get(path).getEvents({ eventTypes: ["events.iterate.com/telegram/webhook-received", "events.iterate.com/telegram/send-requested"] }). Those two event types ARE the transcript (user text in payload.body.message.text, your replies in payload.text); do NOT call getEvents unfiltered — the first page is subscriber/llm plumbing, not conversation — and if exactly 500 events come back, page with afterOffset: events.at(-1).offset to reach the recent end. Only then answer: INTO that thread by appending your send request to that stream instead of your own, or here — your judgement.`,
    `For any other Bot API call (sendPhoto, sendDocument, editMessageText, answerCallbackQuery, …) use ${telegramConnection}.<method>(params) with ONE params object (https://core.telegram.org/bots/api) — these are immediate calls, not journaled sends, so pass chat_id yourself.`,
    'Messages are plain text by default. For formatting pass parse_mode: "HTML" with simple tags (<b>, <i>, <code>, <pre>, <a href>) — Telegram does NOT render markdown headings or tables, so prefer short plain-text replies.',
    "v1 limitation: photos/voice/stickers people send arrive only as bracketed placeholders like [photo] — you cannot view them yet; say so if asked about one.",
    "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply — do not pattern-match response shapes blind or wrap calls in defensive try/catch (a raw thrown error is more useful to you). Use Promise.all to fan out independent calls concurrently.",
    `Keep the chat in the loop on every working turn: when a script does real work, post a short progress note in the same Promise.all as the work itself — Promise.all([${sendRequest(input.agentPath, '"Checking that now..."')}, itx.mcp.exa.web_search_exa({ query })]) — so the chat is never silent while you fetch.`,
    "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
    `To do something later or on a schedule (reminders, recurring reports), use await itx.scheduler.set({ key, recurrence: { in: seconds } | { every: seconds } | { cron, timezone? }, script: "async (itx, schedule, trigger) => { ... }" }) — the script is a STRING run later with full project access; to have it post back to this chat, bake the chat_id into it and call ${telegramConnection}.sendMessage (scheduled scripts outlive sessions, so use the direct call there, not a session send request). itx.scheduler.list() / cancel(key) manage schedules.`,
    'Use project capabilities on itx when they are relevant. FIND WORKING CODE FIRST: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities — matching is dumb word overlap, so more synonyms means better recall; await itx.docs.get({ name }) fetches one. await itx.__describe() works on every node, including provided capabilities.',
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
  "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply.",
  "Write emails like a thoughtful human colleague: plain text by default, greeting and sign-off optional and brief, no markdown formatting (it is not rendered in email).",
  "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
  'Use project capabilities on itx when they are relevant. FIND WORKING CODE FIRST: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities — matching is dumb word overlap, so more synonyms means better recall; await itx.docs.get({ name }) fetches one. await itx.__describe() works on every node, including provided capabilities.',
].join("\n");

/**
 * Agents under `/agents/repos/<slug>/pull-requests/<n>` are pull-request
 * agents: the repo processor forwards that PR's GitHub webhooks to their
 * stream, and the `github-agent` processor folds them into a bounded current
 * projection. Human mentions queue turns; project policy and native per-PR
 * controls can request an automatic review of each new head. Replies go out
 * through the linked connection's `.octokit` capability. Exact coordinates
 * arrive in `github-agent/route-configured`.
 */
const PR_AGENT_SYSTEM_PROMPT = [
  "You are an iterate AI agent attached to one GitHub pull request.",
  TYPESCRIPT_FENCE_INSTRUCTION,
  "The code block must contain a single async arrow function: async (itx) => { ... }.",
  "GitHub webhooks are folded into bounded turn snapshots: current PR metadata and recent activity, including CI. The exact raw webhook remains point-readable by the stream offset in each turn. Read that one event when its summary omits a field; never bulk-load the webhook stream into context.",
  "A human mention normally queues a turn. A configured automatic review of a new head normally interrupts obsolete work. The current turn says exactly what woke you and whether to comment, review, or take repository action.",
  'To reply, use the connection named in route context: await itx.integrations.github["<connection>"].octokit.rest.issues.createComment({ owner, repo, issue_number, body }). To review, use `.octokit.rest.pulls.createReview(...)`. Never use itx.chat.sendMessage to answer the PR.',
  "The `.octokit` property is the ordinary Octokit from `@octokit/rest`, with Iterate supplying installation auth and transport. Use the package types and https://octokit.github.io/rest.js/; `.rest` is Octokit's normal property. There is deliberately no direct `.rest` on the connection.",
  "When asked to change code, fetch the live PR, then clone its head repo/ref into a project sandbox. Sandboxes have git, gh, and the GitHub installation's GH_TOKEN: edit, test, commit, and non-force push the exact head branch there. Never use itx.repo or itx.workspace for PR changes because both write the linked project's default branch. Fork heads may be outside the installation: report that blocker instead of changing the base branch.",
  "GitHub is not chat: one complete, well-written comment per request. Do the work first (read the diff, fetch files, run scripts across turns), then comment once with the full answer. Write in GitHub-flavored markdown.",
  "Your scripts are tool calls. Whatever your function returns (or throws) comes back as your next input and you get another turn; a script that returns undefined ends your turn. Keep snippets small and single-purpose: fetch data and RETURN it so you can look at it before composing a reply.",
  "Web search is built in: await itx.mcp.exa.web_search_exa({ query, numResults }); read pages with itx.mcp.exa.web_fetch_exa({ urls }).",
  'Use project capabilities on itx when they are relevant. FIND WORKING CODE FIRST: await itx.docs.search({ q: "several related words" }) finds e2e-tested example scripts, type declarations, and mounted capabilities — matching is dumb word overlap, so more synonyms means better recall; await itx.docs.get({ name }) fetches one. await itx.__describe() works on every node, including provided capabilities.',
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
  "This overrides the multi-message chat and every-turn progress-update guidance above: send NO acknowledgements or progress updates — the first sendMessage ends the caller's wait, so it must BE the complete answer. Reply exactly once per request with await itx.chat.sendMessage(message). Do the requested work directly with your capabilities; only ask a clarifying question when the request is genuinely ambiguous.",
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

/** THE place the "agent path decides the reply door" rule lives: Slack thread
 * agents reply via their connection's Slack Web API, Telegram chat agents via
 * their connection's Bot API, inbound MCP session agents via their blocked
 * ask_assistant call, everything else via web chat. */
function agentSystemPromptForPath(agentPath: string): string {
  // Child-agent paths FIRST: the routed-agent predicates below are shape-loose
  // (Slack matches any >=6-segment path under its connection, email matches by
  // prefix), so a child under a routed agent must not inherit its transcriber.
  if (childAgentParentPath(agentPath) !== null) return DEFAULT_AGENT_SYSTEM_PROMPT;
  if (agentPath === ONBOARDING_AGENT_PATH) return ONBOARDING_AGENT_SYSTEM_PROMPT;
  const slackConnection = slackConnectionFromAgentPath(agentPath);
  if (slackConnection !== null) {
    return slackAgentSystemPrompt(slackConnection);
  }
  const telegramConnection = telegramConnectionFromAgentPath(agentPath);
  if (telegramConnection !== null) {
    return telegramAgentSystemPrompt({
      agentPath,
      chatId: telegramChatIdFromAgentPath(agentPath),
      connection: telegramConnection,
    });
  }
  if (isEmailAgentPath(agentPath)) return EMAIL_AGENT_SYSTEM_PROMPT;
  if (isGithubAgentPath(agentPath)) return PR_AGENT_SYSTEM_PROMPT;
  if (isMcpAgentPath(agentPath)) return MCP_AGENT_SYSTEM_PROMPT;
  return DEFAULT_AGENT_SYSTEM_PROMPT;
}

/** Caller-supplied policy overrides, baked into the returned events. A
 * systemPrompt override REPLACES the path's platform prompt wholesale — the
 * caller owns the whole contract, including how the agent acts (codemode). */
export type AgentDefaultsOverrides = {
  /** GitHub pull-request behavior. The resulting configured fact always
   * contains the complete materialized policy, including `enabled: false`. */
  githubAgent?: GithubAgentConfigurationInput;
  systemPrompt?: string;
  model?: string;
};

/** The default policy for one agent path: the named pieces plus the exact
 * event batch that applies them (idempotency-keyed, safe to re-append). */
export type AgentDefaultPolicy = {
  systemPrompt: string;
  model: string;
  events: AgentPolicyEventInput[];
};

/** The policy events an agent is born with, as append inputs. Typed
 * structurally (not against the full event catalog) so the SDK projection
 * stays self-contained. */
export type AgentPolicyEventInput = {
  type: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
};

/**
 * The default agent policy for a path. Every agent runs through the single
 * agent processor's Cloudflare AI binding; `overrides` bake caller
 * customization into the returned events so the common case stays one append.
 */
export function agentDefaultsForPath(input: {
  agentPath: string;
  projectId: string;
  /**
   * Human-facing project facts from the directory, when the caller has them:
   * the very first question a real user asked their agent was "which project
   * is this?", and an opaque prj_ hex id was the only answer the boot
   * context could give. Optional because some hosts (tests, bare births)
   * have no directory at hand — the id-only line still works.
   */
  project?: { name: string; slug: string; workerUrl?: string };
  overrides?: AgentDefaultsOverrides;
}): AgentDefaultPolicy {
  const { agentPath, projectId, project } = input;
  const isGithubAgent = isGithubAgentPath(agentPath);
  // Project workers can pass one policy to every agent birth without
  // duplicating the platform's path classifier. It materializes only on an
  // actual GitHub PR agent.
  const githubAgentConfiguration = isGithubAgent
    ? GithubAgentConfiguration.parse(input.overrides?.githubAgent ?? {})
    : null;
  const model = input.overrides?.model ?? DEFAULT_AGENT_MODEL;
  // An override replaces the path prompt wholesale. There is no baked-in
  // child-agent prompt either: child-agent-ness rides on the parent's MESSAGE
  // (the fold labels agent-sourced messages with the sender's path and how to
  // reply — see reduceAgentEvent's message-received arm).
  const systemPrompt = input.overrides?.systemPrompt ?? agentSystemPromptForPath(agentPath);

  const events: AgentPolicyEventInput[] = [
    {
      type: "events.iterate.com/agent/config-updated",
      idempotencyKey: `agent/config-updated:${projectId}:${agentPath}`,
      payload: { systemPrompt },
    },
    {
      type: "events.iterate.com/agent/llm-provider-selected",
      idempotencyKey: `agent/llm-provider-selected:${projectId}:${agentPath}`,
      payload: { ifUnset: true, model },
    },
    ...(githubAgentConfiguration === null
      ? []
      : [
          {
            type: "events.iterate.com/github-agent/configure",
            idempotencyKey: `github-agent/configure:${projectId}:${agentPath}`,
            payload: githubAgentConfiguration,
          },
        ]),
    // The agent's own workspace, a durable itx-expression re-evaluated per
    // call, so agent birth never touches the workspace Durable Object. (No
    // sandbox mount: sandboxes are pets, created explicitly via
    // itx.sandboxes.create.)
    {
      type: "events.iterate.com/capability-host/capability-provided",
      idempotencyKey: `capability-host/workspace-provided:${projectId}:${agentPath}`,
      payload: {
        path: ["workspace"],
        type: "itx-expression",
        expression: ["workspaces", ["get", agentWorkspacePath(agentPath)]],
        instructions:
          `THIS agent's own workspace at "${agentWorkspacePath(agentPath)}" (your agent path under /workspaces): an instant copy-on-write overlay over the config repo's latest main, living in a Durable Object filesystem — no container, no clone, always warm. ` +
          'Reads see latest main until you shadow a path; writes/edits/deletes stay private until committed (readFile/writeFile/edit/readDir/glob/…; paths are absolute, "/" is the repo root). ' +
          "To ship your changes: await itx.workspace.git.commit({ message }) — that commits them straight to the config repo's MAIN branch and the project worker/website redeploys automatically. No branches, no push, no other steps.",
      },
    },
    // Per-agent boot context as a model-visible input (the system prompt is
    // static; ids and paths are not). Facts and pointers only — everything
    // per-capability is discoverable through itx.docs / __describe, so this
    // must not grow back into a capability tour (the prompt budget test
    // holds the line). dont-trigger-request: this must never wake the LLM
    // by itself.
    {
      type: "events.iterate.com/agent/input-added",
      idempotencyKey: `agent/boot-context:${projectId}:${agentPath}`,
      payload: {
        content: [
          "Platform context for this agent:",
          project === undefined
            ? `- Project id: ${projectId}`
            : `- Project: ${JSON.stringify(project.name)} (slug ${project.slug}, id ${projectId})${project.workerUrl === undefined ? "" : ` — the project worker/website serves ${project.workerUrl}`}`,
          `- Your agent stream path: ${agentPath} (your itx scope; your transcript lives here)`,
          // One seed list, marked non-exhaustive, and ONE rule for choosing
          // between the two write doors — the model was repeating this line
          // verbatim to users as the repo's full contents.
          '- The project config repo is at "/repos/config" (itx.repo), seeded with worker.ts (the project worker + website), AGENTS.md, package.json, and more. On a brand-new project it may still be seeding on your first turn — if repo or worker calls say it is missing or not ready, retry shortly instead of treating that as fatal.',
          "- Two write doors, one rule: itx.repo.commitFiles({ message, changes }) for a small direct edit; your private workspace (itx.workspace, a live overlay of the repo's latest main: readFile/writeFile/edit/glob) when you want to read and change several files before shipping ONE commit via itx.workspace.git.commit({ message }). Both land straight on main and redeploy the project worker/website — no branches, no push.",
          "- Delegate by messaging a child agent into existence: await itx.agents.get('researcher').message(task) — put everything the child needs in the message, then end your turn; its report arrives as your input.",
          // Deliberate reinforcement of the prompt's FIND WORKING CODE
          // section — repetition is the one thing small prompts buy back.
          '- FIRST MOVE for anything unfamiliar: await itx.docs.search({ q: "several related words" }) — working example scripts, type declarations, and this project\'s mounted capabilities; each hit carries a fetchCall string, the ready-made itx.docs.get call that fetches its full doc. await itx.__describe() lists everything at your scope.',
        ].join("\n"),
        llmRequestPolicy: { behaviour: "dont-trigger-request" },
      },
    },
    // The onboarding agent starts the conversation itself; every other agent
    // waits for its first input (a web message, Slack webhook, email, ...).
    ...(agentPath === ONBOARDING_AGENT_PATH
      ? [
          {
            type: "events.iterate.com/agent/input-added",
            idempotencyKey: `project-onboarding-start:${projectId}`,
            payload: {
              content:
                "Begin onboarding. The project owner just created this project and is looking at the chat. If the user already sent a message above, answer it first, then continue the onboarding script.",
              llmRequestPolicy: { behaviour: "after-current-request" },
            },
          },
        ]
      : []),
  ];

  return { systemPrompt, model, events };
}
