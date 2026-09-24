import { build } from "esbuild";
import { expect, test, vi } from "vitest";
import type { DelegationMessage } from "./delegation-turn.ts";
import fixtures from "./screen-context-repro.json";

// Whichever row runs first pays for bundling the processor with esbuild
// (`loadVoiceDelegateProcessor()`), which used to run under the hook budget; every row gets that
// budget.
vi.setConfig({ testTimeout: 10_000 });

// September 21 calls: the supplied Markdown was dropped and the agent edited the
// project website. Fixture keeps context + first concrete maths request verbatim;
// audio, transcripts (already in the request), and unrelated lifecycle events omitted.
test.each([
  ...fixtures,
  {
    device: "future_colour_device",
    events: fixtures[0]!.events.map((event) =>
      event.type.endsWith("/context-added")
        ? {
            ...event,
            payload: {
              role: "developer",
              content:
                "# An entirely different device guide\nRender HTML using future_colour_device. Its screen can show colour.",
            },
          }
        : event,
    ),
  },
])(
  "$device: supplied context reaches the model and updates the device",
  async ({ device, events }) => {
    const VoiceDelegateProcessor = await loadVoiceDelegateProcessor();
    const instruction = events[0]!.payload;
    const runScript = vi.fn(async () => '{"shown":true}');
    const complete = vi.fn(async (messages: DelegationMessage[]) => {
      if (messages.at(-1)!.content.startsWith("Script result:"))
        return "The exercises are on your screen.";
      const hasInstructions = messages.some((message) =>
        message.content.includes(instruction.content!),
      );
      if (!hasInstructions) return "The website has the exercises.";
      return `<codemode>\nreturn await itx.cd("/").voice.setImage({device: "${device}", image: {html: "<h1>Maths practice</h1>"}})\n</codemode>`;
    });
    const processor = new VoiceDelegateProcessor({ complete, runScript });
    let state = processor.contract.initialState();
    for (const event of events) state = processor.reduce({ state, event });
    // A new incarnation answers from durable reduced context, just like recovery.
    const resumed = new VoiceDelegateProcessor({ complete, runScript });
    const work: Promise<unknown>[] = [];
    const append = vi.fn(async () => []);
    resumed.processEvent({
      state,
      previousState: state,
      event: null,
      delivery: { caughtUp: true },
      append,
      runInBackground: (fn: () => Promise<unknown>) => work.push(fn()),
      blockProcessorWhile: (fn: () => Promise<unknown>) => work.push(fn()),
    });
    await Promise.all(work);
    expect(runScript).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining(`device: "${device}"`),
    );
    expect(complete.mock.calls[0]![0]).toContainEqual({
      role: instruction.role,
      content: instruction.content,
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "events.iterate.com/voice-agent/commentary",
        payload: expect.objectContaining({ content: "The exercises are on your screen." }),
      }),
    );
  },
);

test("a later request remembers the exercise it displayed, including after recovery", async () => {
  const VoiceDelegateProcessor = await loadVoiceDelegateProcessor();
  const complete = vi.fn(async (messages: DelegationMessage[]) => {
    if (messages.at(-1)!.content === "Is seven correct for the first question?") {
      return messages.some((message) => message.content.includes("49 / 7"))
        ? "Yes, 49 divided by 7 is 7."
        : "What was the question?";
    }
    if (messages.at(-1)!.content.startsWith("Script result:")) return "The exercise is displayed.";
    return '<codemode>\nreturn await itx.cd("/").voice.setImage({ device: "zectrix_note4", image: { html: "<h1>49 / 7 = ?</h1>" } })\n</codemode>';
  });
  const deps = { complete, runScript: vi.fn(async () => '{"shown":true}') };
  let processor = new VoiceDelegateProcessor(deps);
  let state = processor.contract.initialState();
  const emitted: any[] = [];
  const append = async (...events: any[]) => {
    emitted.push(...events);
    for (const event of events) state = processor.reduce({ state, event });
    return [];
  };
  for (const [delegationId, text] of [
    ["first", "Show a division exercise"],
    ["second", "Is seven correct for the first question?"],
  ]) {
    // Reconstruct with only the durable state; no in-memory model history survives.
    processor = new VoiceDelegateProcessor(deps);
    state = processor.reduce({
      state,
      event: {
        type: "events.iterate.com/voice-agent/delegation-requested",
        payload: {
          activation: "test",
          delegationId,
          conversationId: "test",
          transcript: [{ role: "listener", text }],
        },
      },
    });
    const work: Promise<unknown>[] = [];
    processor.processEvent({
      state,
      previousState: state,
      event: null,
      delivery: { caughtUp: true },
      append,
      runInBackground: (fn: () => Promise<unknown>) => work.push(fn()),
    });
    await Promise.all(work);
  }
  expect(deps.runScript).toHaveBeenCalledTimes(1);
  expect(emitted.at(-1).payload).toMatchObject({ content: "Yes, 49 divided by 7 is 7." });
  expect(
    emitted
      .filter((event) => event.type.endsWith("/context-added"))
      .map((event) => event.payload.role),
  ).toEqual(["assistant", "user"]);
});

let voiceDelegateProcessor: Promise<any> | undefined;

/**
 * The real voice-delegate processor, bundled against the real processor contract with only the
 * Cloudflare host stubbed out, built once per file on first use.
 */
function loadVoiceDelegateProcessor(): Promise<any> {
  voiceDelegateProcessor ||= (async () => {
    const processor = new URL(
      "../../../packages/iterate/src/next/stream/processor.ts",
      import.meta.url,
    ).pathname;
    const bundle = await build({
      entryPoints: [new URL("./voice-delegate.ts", import.meta.url).pathname],
      bundle: true,
      write: false,
      format: "esm",
      platform: "node",
      loader: { ".md": "text" },
      plugins: [
        {
          name: "processor-runtime",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/processor\.js$/ }, () => ({
              path: "processor",
              namespace: "test-runtime",
            }));
            builder.onLoad({ filter: /.*/, namespace: "test-runtime" }, () => ({
              // Real contract and processor; only the Cloudflare host is absent in Node.
              contents: `export * from ${JSON.stringify(processor)}; export { z } from "zod"; export class StreamProcessorDurableObject {}`,
              resolveDir: new URL(".", import.meta.url).pathname,
            }));
          },
        },
      ],
    });
    const { VoiceDelegateProcessor } = await import(
      `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
    );
    return VoiceDelegateProcessor;
  })();
  return voiceDelegateProcessor;
}
