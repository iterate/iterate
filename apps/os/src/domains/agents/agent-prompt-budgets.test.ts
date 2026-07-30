// Token-budget guards on every platform agent prompt. The 2026-07 prompt diet
// took the default web-chat birth turn from ~33k tokens (a verbatim 115KB
// type-surface embed) to under 3k by making the surface DISCOVERABLE at
// runtime (itx.docs + __describe) instead of front-loaded. Prompts regrow by
// accretion; these ceilings turn the next regression into red CI instead of a
// production bill.
//
// Budgets are in characters (no tokenizer in-repo); ~4 chars/token, so the
// 3,000-token ceiling on the default prompt is 12,000 chars.
import { expect, test } from "vitest";
import { ITX_API_DECLARATIONS } from "../../itx-api-graph.generated.ts";
import { ITX_EXAMPLES } from "../../itx/examples.ts";
import {
  EXEC_TYPESCRIPT_DESCRIPTION,
  inboundMcpServerInstructions,
} from "../inbound-mcp-server/exec-typescript-description.ts";
import {
  AGENT_SUMMARY_INSTRUCTION,
  DEFAULT_AGENT_SYSTEM_PROMPT,
  EMAIL_AGENT_SYSTEM_PROMPT,
  agentCreationForPath,
  slackAgentSystemPrompt,
  telegramAgentSystemPrompt,
} from "./agent-defaults.ts";

const CHARS_PER_TOKEN = 4;
// 3,000 until 2026-07; raised once, deliberately, when the prompt gained the
// OTHER AGENTS and MAKE YOUR OWN TOOLS sections (delegation and custom
// capabilities were the two key bits the diet had cut too deep to keep).
// Still an order of magnitude under the 33k it replaced — the next raise
// should be argued in a PR, not absorbed.
// 3500 → 3600 (2026-07-14): the original presentation teach was an explicit
// product ask and did not fit the previous ceiling's ~15-token headroom.
// 3600 → 3800 (2026-07-18): summary became an event-first lifecycle with
// mandatory first-turn title, second-turn activity, and final-turn waiting.
// Three short code patterns keep the lifecycle concrete.
const DEFAULT_PROMPT_TOKEN_CEILING = 3_800;

const AGENT_PROMPTS: Record<string, string> = {
  default: DEFAULT_AGENT_SYSTEM_PROMPT,
  email: EMAIL_AGENT_SYSTEM_PROMPT,
  slack: slackAgentSystemPrompt("main-slack"),
  telegram: telegramAgentSystemPrompt({
    agentPath: "/agents/telegram/main/chat-42",
    chatId: "42",
    connection: "main",
  }),
};

const CHANNEL_PROMPTS: Record<string, string> = {
  ...AGENT_PROMPTS,
  // The inbound MCP instructions and tool description are prompts in all but
  // name — they ride MCP client conversations, so they obey the same budget
  // and name-resolution rules.
  execTypescriptTool: EXEC_TYPESCRIPT_DESCRIPTION,
  mcpServer: inboundMcpServerInstructions({ withAgent: false }),
  mcpServerWithAgent: inboundMcpServerInstructions({ withAgent: true }),
};

test(`the default prompt stays under ${DEFAULT_PROMPT_TOKEN_CEILING} tokens`, () => {
  expect(DEFAULT_AGENT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(
    DEFAULT_PROMPT_TOKEN_CEILING * CHARS_PER_TOKEN,
  );
});

test("the default prompt teaches agents to share workspace files through Docs", () => {
  expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
    'itx.worker.docs.link({ workspace: "/workspaces/agents/you", path: "/review.md" })',
  );
  expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain("Comments and Markdown edits write directly");
  expect(DEFAULT_AGENT_SYSTEM_PROMPT).toContain(
    "This is not `itx.docs`, which searches API documentation.",
  );
});

test("every agent prompt teaches the summary turn lifecycle and append event", () => {
  expect(AGENT_SUMMARY_INSTRUCTION.length).toBeLessThanOrEqual(1_200);
  expect(AGENT_SUMMARY_INSTRUCTION).toContain("FIRST TURN:");
  expect(AGENT_SUMMARY_INSTRUCTION).toContain("SECOND TURN:");
  expect(AGENT_SUMMARY_INSTRUCTION).toContain("WHEN RETURNING NO VALUE / WAITING FOR USER:");
  expect(AGENT_SUMMARY_INSTRUCTION.match(/await Promise\.all\(\[/g)).toHaveLength(3);
  expect(AGENT_SUMMARY_INSTRUCTION).toContain(
    'payload: { title: "Short specific title", activity: "Starting work" }',
  );
  expect(AGENT_SUMMARY_INSTRUCTION).toContain("events.iterate.com/agent/summary-updated");
  expect(AGENT_SUMMARY_INSTRUCTION).toContain("send your reply through this channel's reply API");
  expect(AGENT_SUMMARY_INSTRUCTION).not.toContain("itx.chat.sendMessage");

  for (const [channel, prompt] of Object.entries(AGENT_PROMPTS)) {
    expect(prompt, `${channel} lacks the summary lifecycle block`).toContain(
      AGENT_SUMMARY_INSTRUCTION,
    );
  }
});

test("no platform prompt embeds the type surface", () => {
  // The whole point of the docs door: the flat type file never rides a
  // prompt again. "export interface Project" only appears in prompts as an
  // embed of the generated file.
  for (const [channel, prompt] of Object.entries(CHANNEL_PROMPTS)) {
    expect(prompt, `${channel} prompt embeds the type surface`).not.toContain(
      "export interface Project {",
    );
    expect(prompt.length, `${channel} prompt is over 6k tokens`).toBeLessThanOrEqual(
      6_000 * CHARS_PER_TOKEN,
    );
  }
});

test("the boot-context input stays facts-and-pointers sized", () => {
  const policy = agentCreationForPath({ agentPath: "/agents/test", projectId: "prj_test" });
  const bootContext = policy.events.find(
    (event) =>
      event.type === "events.iterate.com/agents/context-added" &&
      (event.payload as { key?: string }).key === "agent/boot-context",
  );
  expect(bootContext).toBeDefined();
  const content = (bootContext!.payload as { content?: string }).content ?? "";
  // ~500 tokens: room for ids, paths, and one-line pointers — not a tour.
  expect(content.length).toBeLessThanOrEqual(500 * CHARS_PER_TOKEN);
});

test("every docs name referenced in prompts and boot context resolves", () => {
  // Dialed-by-name strings are the bug class where a rename silently strands
  // the prompt (see the #1816/#1818 incident): every `docs.get({ name: "…" })`
  // literal must resolve to a real example id or type declaration name.
  const policy = agentCreationForPath({ agentPath: "/agents/test", projectId: "prj_test" });
  const bootContent = policy.events
    .map((event) => (event.payload as { content?: string }).content ?? "")
    .join("\n");
  const corpus = [...Object.values(CHANNEL_PROMPTS), bootContent, policy.systemPrompt].join("\n");

  const referencedNames = [
    // Both quoted docs.get names and backtick-quoted bare example ids
    // (`ai-generate-image`) — a rename must not strand either spelling.
    ...corpus.matchAll(/docs\.get\(\{ name: "([^"]+)"/g),
    ...corpus.matchAll(/`((?:[a-z0-9]+-)+[a-z0-9]+)`/g),
  ].map((match) => match[1]!);
  expect(referencedNames.length).toBeGreaterThan(0);

  const known = new Set([
    ...ITX_EXAMPLES.map((example) => example.id),
    ...ITX_API_DECLARATIONS.map((declaration) => declaration.name),
  ]);
  const unresolved = referencedNames.filter((name) => !known.has(name));
  expect(unresolved).toEqual([]);
});
