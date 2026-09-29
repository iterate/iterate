// One tab's side of co-editing a doc (@iterate-com/docs frames.ts): the text as a Y.Doc, synced
// with the doc's processor, and who else is here (y-protocols awareness). Every edit goes out as an
// ephemeral `docs/edit-frame` on the doc's context and comes in the same way; the processor holds
// the text between tabs and saves it, so an edit is safe once it has been sent. Closing the doc
// says `docs/left` once the last edit is out: the last tab to leave has the processor save at once.
//
// Frames can go missing (an ephemeral push dropped under load, a send that failed), and Yjs updates
// apply in any order and more than once, so the tab just syncs again with the processor, both ways:
// when an update arrives that needs one it never got, after a failed send, and after each save.
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import type { IterateContextApi } from "iterate/api";
import type { DocDurableObject } from "@iterate-com/docs";
import {
  AWARENESS_FRAME,
  AwarenessFrame,
  DOC_LEFT,
  EDIT_FRAME,
  EditFrame,
  fromBase64,
  toBase64,
} from "@iterate-com/docs/frames";

export type CollabStatus =
  | { kind: "opening" }
  | { kind: "live" }
  | { kind: "failed"; message: string };

/** An empty Yjs update: nothing the other side lacks. */
const NOTHING = 2;

export class DocCollab {
  doc = new Y.Doc();
  text = this.doc.getText("file");
  awareness = new Awareness(this.doc);
  #context: IterateContextApi;
  #onStatus: (status: CollabStatus) => void;
  #outbox: Uint8Array[] = [];
  #sending = false;
  /** The edits being sent now, if any: what closing waits for before it says `docs/left`. */
  #flushing = Promise.resolve();
  #syncing: Promise<void> | null = null;
  /** `open()` while it runs: closing waits for it, so the goodbye can't overtake the hello. */
  #opening: Promise<void> | null = null;
  #syncAgain = false;
  #disposed = false;
  #subscription: Disposable | null = null;

  constructor(options: {
    context: IterateContextApi;
    user: { name: string; color: string };
    onStatus: (status: CollabStatus) => void;
  }) {
    this.#context = options.context;
    this.#onStatus = options.onStatus;
    this.awareness.setLocalStateField("user", {
      name: options.user.name,
      color: options.user.color,
      colorLight: `${options.user.color}33`,
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== this) this.#send(update);
    });
    this.awareness.on(
      "update",
      ({ added }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin !== this) return void this.#sendAwareness();
        // someone new: tell them who's here, rather than leaving it to the 15 s heartbeat
        if (added.some((client) => client !== this.doc.clientID)) this.#sendAwareness();
      },
    );
  }

  /** Subscribe, then take the processor's text: a frame racing the first sync waits in Yjs until
   *  the update it builds on arrives. */
  open() {
    this.#opening = this.#open();
    return this.#opening;
  }

  async #open() {
    this.#subscription = await this.#context.subscribe({
      consumes: [EDIT_FRAME, AWARENESS_FRAME],
      target: (events) => {
        if (!this.#disposed) for (const event of events) this.#receive(event);
      },
    });
    await this.sync();
    // here: the others answer with theirs
    this.#sendAwareness();
  }

  /** Exchange with the processor what each lacks, by state vector. One at a time; a call during
   *  one runs once more after it. */
  sync(): Promise<void> {
    if (this.#syncing) {
      this.#syncAgain = true;
      return this.#syncing;
    }
    this.#syncing = this.#syncUntilWhole().finally(() => {
      this.#syncing = null;
    });
    return this.#syncing;
  }

  async #syncUntilWhole() {
    do {
      this.#syncAgain = false;
      try {
        const facet = this.#context.facets.get<Pick<DocDurableObject, "sync">>("doc");
        const answer = await facet.sync(toBase64(Y.encodeStateVector(this.doc)), this.doc.clientID);
        Y.applyUpdate(this.doc, fromBase64(answer.update), this);
        const missing = Y.encodeStateAsUpdate(this.doc, fromBase64(answer.stateVector));
        if (missing.length > NOTHING) this.#send(missing);
        this.#onStatus({ kind: "live" });
      } catch (error) {
        this.#onStatus({ kind: "failed", message: messageOf(error) });
        return;
      }
    } while (this.#syncAgain || this.#missingUpdates());
  }

  /** Leave the doc: the others are told this tab has gone (the awareness handler sends it), and
   *  once the last edit is out, the processor (`docs/left`). Resolves when that has been sent, so
   *  the caller keeps the context until then. */
  async close() {
    if (this.#disposed) return;
    this.#disposed = true;
    removeAwarenessStates(this.awareness, [this.doc.clientID], "left");
    // A sync still on its way would say this tab is here after its goodbye, and the processor
    // would wait on it until its minute is up; a subscription still being made would outlive it.
    await this.#opening?.catch(() => {});
    await this.#syncing;
    this.#subscription?.[Symbol.dispose]();
    this.awareness.destroy();
    await this.#flushing;
    await this.#context
      .append({ type: DOC_LEFT, ephemeral: true, payload: { client: this.doc.clientID } })
      // a lost goodbye costs only time: the processor saves a minute after the first edit anyway
      .catch(() => {});
  }

  /** Edits this tab made that haven't reached the doc's context yet. */
  unsent() {
    return this.#sending || this.#outbox.length > 0;
  }

  #receive(raw: unknown) {
    // capnweb hands each event as a proxy: a plain copy to parse
    const event = JSON.parse(JSON.stringify(raw)) as { type: string; payload: unknown };
    if (event.type === AWARENESS_FRAME) {
      const frame = AwarenessFrame.safeParse(event.payload);
      if (frame.success && frame.data.client !== this.doc.clientID)
        applyAwarenessUpdate(this.awareness, fromBase64(frame.data.update), this);
      return;
    }
    const frame = EditFrame.safeParse(event.payload);
    if (!frame.success || frame.data.client === this.doc.clientID) return;
    Y.applyUpdate(this.doc, fromBase64(frame.data.update), this);
    if (this.#missingUpdates()) void this.sync();
  }

  /** Yjs holds an update back while one it builds on hasn't arrived. */
  #missingUpdates() {
    return this.doc.store.pendingStructs !== null || this.doc.store.pendingDs !== null;
  }

  /** Send one frame at a time; what's typed meanwhile goes as one merged update after it. */
  #send(update: Uint8Array) {
    this.#outbox.push(update);
    if (!this.#sending) this.#flushing = this.#flush();
  }

  async #flush() {
    this.#sending = true;
    try {
      while (this.#outbox.length > 0) {
        const update = Y.mergeUpdates(this.#outbox.splice(0));
        await this.#context.append({
          type: EDIT_FRAME,
          ephemeral: true,
          payload: { update: toBase64(update), client: this.doc.clientID },
        });
      }
    } catch (error) {
      // the text is still here: the next sync sends the processor whatever it lacks
      this.#outbox = [];
      this.#onStatus({ kind: "failed", message: messageOf(error) });
    } finally {
      this.#sending = false;
    }
  }

  #sendAwareness() {
    const update = encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
    // who's here is best effort: a lost frame is sent again by the next cursor move or heartbeat
    this.#context
      .append({
        type: AWARENESS_FRAME,
        ephemeral: true,
        payload: { update: toBase64(update), client: this.doc.clientID },
      })
      .catch(() => {});
  }
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
