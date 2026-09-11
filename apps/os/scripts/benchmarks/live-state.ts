/** Run with `pnpm --dir apps/os exec tsx scripts/benchmarks/live-state.ts`.
 * Actual codec, transient reads and client stores across three JSON boundaries.
 * No network latency is included; bytes and synchronous CPU are the measurements. */
import { appendText, sliceText } from "@iterate-com/shared/chunked-text";
import { createJsonByteLength } from "@iterate-com/shared/json-byte-length";
import { createLiveStateStore, LiveState, type LiveStateCursor } from "iterate/sdk/capnweb";

const fixedSteps = Array.from({ length: 12 }, (_, index) => ({
  id: `code-${index}`,
  kind: "code",
  code: "x".repeat(2000),
}));
const snapshot = (text: ReturnType<typeof appendText>) => ({
  steps: [...fixedSteps, { id: "llm", kind: "llm", text }],
});

function benchmark(size: number, chunkSize: number) {
  let text = appendText("", "");
  const links: {
    engine: LiveState<ReturnType<typeof snapshot>>;
    mirror: ReturnType<typeof createLiveStateStore<ReturnType<typeof snapshot>>>;
    cursor: LiveStateCursor | undefined;
    bytes: number;
    frames: number;
    sealedGroup: object | undefined;
  }[] = Array.from({ length: 3 }, () => ({
    engine: new LiveState(snapshot(text)),
    mirror: createLiveStateStore<ReturnType<typeof snapshot>>(),
    cursor: undefined,
    bytes: 0,
    frames: 0,
    sealedGroup: undefined,
  }));
  const byteLength = createJsonByteLength();
  const encoder = new TextEncoder();
  const started = performance.now();
  for (let offset = 0; offset < size; offset += chunkSize) {
    text = appendText(text, "x".repeat(Math.min(chunkSize, size - offset)));
    let state = snapshot(text);
    byteLength(state);
    for (const link of links) {
      link.engine.setState(state);
      const read = link.engine.readSince(link.cursor);
      const encoded = JSON.stringify(read);
      link.bytes += encoder.encode(encoded).byteLength;
      link.frames += 1;
      // This loop decodes exactly its own typed producer's output, simulating
      // a JSON transport without adding an unrelated domain-schema traversal.
      const decoded = JSON.parse(encoded) as typeof read;
      if (!decoded.update) throw new Error("Missing append update");
      link.mirror.apply(decoded.update, () => {
        throw new Error("Unexpected revision gap");
      });
      link.cursor = {
        epoch: decoded.epoch,
        revision: decoded.update.type === "snapshot" ? decoded.update.revision : decoded.update.to,
      };
      state = link.mirror.getState()!;
      const currentText = state.steps.at(-1)!;
      if (!("text" in currentText)) throw new Error("Missing live text");
      if (text.length === 32768) link.sealedGroup = currentText.text.groups[0];
      if (text.length > 32768 && link.sealedGroup !== currentText.text.groups[0]) {
        throw new Error("Transport replaced a sealed text group");
      }
    }
  }
  const durationMs = performance.now() - started;
  const tail = links.at(-1)!.mirror.getState()!.steps.at(-1)!;
  if (!("text" in tail) || sliceText(tail.text) !== "x".repeat(size)) {
    throw new Error("Stream content was lost or duplicated");
  }
  return {
    size,
    chunkSize,
    durationMs,
    links: links.map(({ bytes, frames }) => ({ bytes, frames })),
  };
}

console.log(
  JSON.stringify(
    [65536, 1048576, 4194304].map((size) => benchmark(size, 1024)),
    null,
    2,
  ),
);
