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
import { DEFAULT_AGENT_SYSTEM_PROMPT } from "./agent-processor-contract.ts";
import {
  EMAIL_AGENT_SYSTEM_PROMPT,
  agentDefaultsForPath,
  slackAgentSystemPrompt,
  telegramAgentSystemPrompt,
} from "./agent-defaults.ts";

const CHARS_PER_TOKEN = 4;
const DEFAULT_PROMPT_TOKEN_CEILING = 3_000;

const CHANNEL_PROMPTS: Record<string, string> = {
  default: DEFAULT_AGENT_SYSTEM_PROMPT,
  email: EMAIL_AGENT_SYSTEM_PROMPT,
  slack: slackAgentSystemPrompt("main-slack"),
  telegram: telegramAgentSystemPrompt({
    agentPath: "/agents/telegram/main/chat-42",
    chatId: "42",
    connection: "main",
  }),
};

test(`the default prompt stays under ${DEFAULT_PROMPT_TOKEN_CEILING} tokens`, () => {
  expect(DEFAULT_AGENT_SYSTEM_PROMPT.length).toBeLessThanOrEqual(
    DEFAULT_PROMPT_TOKEN_CEILING * CHARS_PER_TOKEN,
  );
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
  const policy = agentDefaultsForPath({ agentPath: "/agents/test", projectId: "prj_test" });
  const bootContext = policy.events.find((event) =>
    event.idempotencyKey.startsWith("agent/boot-context:"),
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
  const policy = agentDefaultsForPath({ agentPath: "/agents/test", projectId: "prj_test" });
  const bootContent = policy.events
    .map((event) => (event.payload as { content?: string }).content ?? "")
    .join("\n");
  const corpus = [...Object.values(CHANNEL_PROMPTS), bootContent, policy.systemPrompt].join("\n");

  const referencedNames = [
    ...corpus.matchAll(/docs\.get\(\{ name: "([^"]+)"/g),
    ...corpus.matchAll(/docs\.get\(\{ name: ([A-Za-z-]+) \}\)/g),
  ].map((match) => match[1]!);
  expect(referencedNames.length).toBeGreaterThan(0);

  const known = new Set([
    ...ITX_EXAMPLES.map((example) => example.id),
    ...ITX_API_DECLARATIONS.map((declaration) => declaration.name),
  ]);
  const unresolved = referencedNames.filter((name) => !known.has(name));
  expect(unresolved).toEqual([]);
});
