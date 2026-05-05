import type { EventInput } from "@iterate-com/events-contract";

export type CodemodeExample = {
  slug: string;
  name: string;
  description: string;
  code: string;
  events: EventInput[];
};

export const codemodeExamples = [
  {
    slug: "slow-progress",
    name: "Slow progress stream",
    description: "Emit ten progress log lines with a one second delay between each step.",
    code: `async (ctx) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let step = 1; step <= 10; step += 1) {
    console.log(\`running step \${step}/10\`);
    await wait(1000);
  }

  return { ok: true, steps: 10 };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-started",
        payload: { example: "slow-progress" },
      },
    ],
  },
  {
    slug: "custom-events",
    name: "Custom event notebook",
    description: "Start with a few scenario events, then add script logs and a result.",
    code: `async () => {
  console.log("custom events were preloaded before this script ran");

  return {
    note: "script output is recorded on the script-execution-completed event",
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "this event was preloaded before the script ran" },
      },
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "custom events are ordinary event inputs" },
      },
    ],
  },
  {
    slug: "public-api-preset",
    name: "Inspect a public API preset",
    description: "Select the Public APIs preset, then confirm provider docs are registered.",
    code: `async () => {
  console.log("the Public APIs preset registers model-visible provider documentation");

  return {
    providers: ["petstore", "apis"],
    note: "runtime API calls need a provider processor to append function-call-completed",
  };
}`,
    events: [
      {
        type: "events.iterate.com/codemode/example-note",
        payload: { message: "select the Public APIs preset before creating this session" },
      },
    ],
  },
] satisfies CodemodeExample[];

export function findCodemodeExample(slug: string | undefined) {
  if (!slug) return undefined;
  return codemodeExamples.find((example) => example.slug === slug);
}
