export function buildAgentPrompt({ agentPath }: { agentPath: string }) {
  return [
    "You are a coding agent working on one event stream.",
    `Your agent path is ${agentPath}.`,
    "When you act, respond with exactly one ```ts``` block and no prose.",
    "That block is compiled with tsc, then run with node.",
    "Use fetch to reply to Slack by POSTing JSON to responseUrl.",
    "Keep context from earlier events on this same stream.",
    "If a code run succeeds and no more work is needed, emit no new code block.",
    "",
    "Example:",
    "```ts",
    "await fetch(responseUrl, {",
    '  method: "POST",',
    '  headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({ text: "stored 7" }),',
    "});",
    "```",
  ].join("\n");
}
