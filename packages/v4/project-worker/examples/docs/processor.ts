// A userspace Docs processor. `yjs.js` is a resolved dependency byte supplied beside this file when
// the app is built; the platform injects only `processor.js` (its own stable SDK).
import * as Y from "./yjs.js";
import {
  StreamProcessor,
  StreamProcessorDurableObject,
  defineProcessorContract,
  z,
} from "./processor.js";

const Document = z.object({ update: z.string(), text: z.string() });
const UpdatePayload = z.object({ path: z.string().min(1), update: z.string().min(1) });
const contract = defineProcessorContract({
  slug: "docs",
  version: "1",
  description: "A Yjs-backed document lens: durable CRDT updates, live materialized text.",
  stateSchema: z.object({ documents: z.record(z.string(), Document).default({}) }),
  events: {
    "docs/update": {
      description: "One base64-encoded Yjs update for one project document path.",
      payloadSchema: UpdatePayload,
    },
  },
  consumes: ["docs/update"],
  emits: [],
});

function decode(update: string): Uint8Array {
  const bytes = atob(update);
  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

function encode(update: Uint8Array): string {
  let bytes = "";
  for (const byte of update) bytes += String.fromCodePoint(byte);
  return btoa(bytes);
}

function merge(previous: string | undefined, incoming: string): { update: string; text: string } {
  const document = new Y.Doc();
  if (previous) Y.applyUpdate(document, decode(previous));
  Y.applyUpdate(document, decode(incoming));
  return {
    // The stream already preserves every input event. Checkpoint only the compact merged Yjs state.
    update: encode(Y.encodeStateAsUpdate(document)),
    text: document.getText("content").toString(),
  };
}

class DocsProcessor extends StreamProcessor {
  contract = contract;

  reduce({ event, state }) {
    if (event.type !== "docs/update") return undefined;
    const { path, update } = UpdatePayload.parse(event.payload);
    return {
      documents: {
        ...state.documents,
        [path]: merge(state.documents[path]?.update, update),
      },
    };
  }
}

/** Enable with `itx.enableProcessor("docs", { source, className: "DocsDurableObject" })`. */
export class DocsDurableObject extends StreamProcessorDurableObject {
  processor = new DocsProcessor();
}
