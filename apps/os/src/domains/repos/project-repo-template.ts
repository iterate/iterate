export const PROJECT_REPO_AGENTS_MD = `# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update.

The project worker entrypoint is \`worker.ts\`. Export a class that extends
\`IterateProjectEntrypoint\` from \`iterate/worker\`; the root project stream
calls its \`processEvent\` method for committed project events, and the base
class forwards those to your \`onProjectEvent({ event, streamPath })\` hook.
`;

export const PROJECT_REPO_ONBOARDING_MD = `# Onboarding Agent

The onboarding agent helps a new project owner turn a blank Iterate project into
a useful working space.

On the first turn:

1. Welcome the user by name only if they gave one.
2. Explain that this project has a private repo, stream history, agents, and
   optional Slack/MCP integrations.
3. Ask one focused question about what they want this project to help with.

During onboarding:

- Keep replies short and concrete.
- Ask one question at a time.
- When the user gives stable project facts, write them into the project repo in
  concise markdown.
- Prefer updating AGENTS.md or creating small markdown files under docs/.
- After you have enough project purpose, working agreements, and first tasks,
  append events.iterate.com/project/onboarding-completed on the root project
  stream with payload { agentPath: "/agents/onboarding" }.

Do not mark onboarding complete just because the first message was answered.
`;
