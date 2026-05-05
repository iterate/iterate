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
    description: "Emit ten progress events with a one second delay between each step.",
    code: `async (ctx) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  for (let step = 1; step <= 10; step += 1) {
    console.log(\`running step \${step}/10\`);
    await ctx.codemode.append({
      type: "events.iterate.com/codemode/example-progress",
      payload: { step, total: 10 },
    });
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
    description: "Start with a few scenario events, then read the stream path from code.",
    code: `async (ctx) => {
  const streamPath = await ctx.codemode.getStreamPath();
  console.log("attached to", streamPath);
  await ctx.codemode.append({
    type: "events.iterate.com/codemode/example-note",
    payload: { message: "the script can add its own events too" },
  });

  return { streamPath };
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
    name: "Use a public API preset",
    description: "Select the Public APIs preset, then call Petstore and APIs.guru tools.",
    code: `async (ctx) => {
  const inventory = await ctx.petstore.getInventory({});
  const metrics = await ctx.apis.getMetrics({});

  console.log("petstore inventory keys", Object.keys(inventory).join(", "));
  console.log("apis.guru metrics", JSON.stringify(metrics));

  return { inventory, metrics };
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
