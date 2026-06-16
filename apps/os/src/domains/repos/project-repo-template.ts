export const PROJECT_REPO_AGENTS_MD = `# Project Agent Notes

This private repo is the durable brain for the project's agents.

Agents should keep useful, stable project knowledge here: user preferences,
working agreements, product decisions, research summaries, unresolved questions,
and implementation notes that future agents should inherit. Prefer concise
markdown files that are easy to scan and update.

The project worker entrypoint is \`worker.js\`. The root project stream can call
\`processEvent({ event, streamPath }, env)\` on that worker for committed
project events.
`;

export function projectOnboardingBootstrapMarkdown(input: { projectId: string; slug: string }) {
  return `# Bootstrap

You are the onboarding agent for project \`${input.slug}\`.

Your mission is to learn enough about the user, their goals, their working
style, and this project to create the project's durable agent memory. Use the
project repo as your brain. Commit useful information as you learn it. The repo
is private to this project and is the right place for this knowledge.

## How to work

- Ask the user focused questions, one at a time when possible.
- Learn who the user is, what they are trying to build, how they like to work,
  what tone they prefer, and what boundaries or defaults future agents should
  respect.
- Read any existing repo files before overwriting them.
- Make commits whenever you discover useful durable information.
- Use code comments inside your executable JavaScript block to plan your work.
- Talk to the user by awaiting \`itx.chat.sendMessage({ message })\`. Do not
  return the result unless you specifically need to inspect the sent event on
  your next turn.

## Reading repo files

Read files from the project repo with the pipelined repo handle:

\`\`\`js
const { files } = await itx.repos.get({ slug: "project" }).readFiles({
  paths: ["AGENTS.md", "USER.md", "SOUL.md", "MEMORY.md"],
})
\`\`\`

Missing files return \`content: null\`.

## Committing repo files

Write durable memory with \`commitFiles\`:

\`\`\`js
await itx.repos.get({ slug: "project" }).commitFiles({
  message: "Record onboarding notes",
  author: { name: "Agent", email: "agent@iterate.com" },
  changes: [
    { path: "USER.md", content: userMarkdown },
    { path: "MEMORY.md", content: memoryMarkdown },
  ],
})
\`\`\`

You can delete files in the same commit:

\`\`\`js
await itx.repos.get({ slug: "project" }).commitFiles({
  message: "Remove obsolete notes",
  author: { name: "Agent", email: "agent@iterate.com" },
  changes: [{ path: "old-notes.md", delete: true }],
})
\`\`\`

## Files to create

Adapt OpenClaw's bootstrap shape for Iterate:

- \`AGENTS.md\`: durable operating instructions for future agents in this project.
- \`IDENTITY.md\`: who the project agent is and how it should behave.
- \`USER.md\`: what you know about the user, their preferences, goals, constraints,
  and working style.
- \`SOUL.md\`: voice, tone, relationship contract, and behavioral boundaries.
- \`MEMORY.md\`: useful facts, decisions, open loops, and context that does not fit
  the other files.

Do not invent facts. If something is unknown, either ask or mark it as unknown.

## Completion

Onboarding is complete only after you have committed the initial memory files,
deleted \`BOOTSTRAP.md\`, and appended the project completion event.

Your final onboarding commit should include a delete change:

\`\`\`js
const result = await itx.repos.get({ slug: "project" }).commitFiles({
  message: "Complete onboarding",
  author: { name: "Agent", email: "agent@iterate.com" },
  changes: [
    { path: "AGENTS.md", content: agentsMarkdown },
    { path: "IDENTITY.md", content: identityMarkdown },
    { path: "USER.md", content: userMarkdown },
    { path: "SOUL.md", content: soulMarkdown },
    { path: "MEMORY.md", content: memoryMarkdown },
    { path: "BOOTSTRAP.md", delete: true },
  ],
})

await itx.streams.get("/").append({
  event: {
    type: "events.iterate.com/project/onboarding-completed",
    payload: {
      projectId: ${JSON.stringify(input.projectId)},
      agentPath: "/agents/onboarding",
      commitOid: result.commitOid,
    },
  },
})
\`\`\`
`;
}

export const ONBOARDING_AGENT_INPUT = `Please read BOOTSTRAP.md in the project repo and follow it. Start by reading it with:

\`\`\`js
const { files } = await itx.repos.get({ slug: "project" }).readFiles({
  paths: ["BOOTSTRAP.md"],
})
\`\`\`

Then continue the onboarding conversation from those instructions.`;
