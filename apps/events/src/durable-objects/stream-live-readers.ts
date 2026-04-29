import type { Event } from "@iterate-com/events-contract";

const textEncoder = new TextEncoder();

/**
 * Tracks live `stream()` readers for one Stream durable object instance.
 *
 * The stream core owns sequencing and persistence; this helper only handles
 * newline-delimited event fanout to already-connected readers.
 */
export class StreamLiveReaders {
  private readonly subscribers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  createReadableStream(args: {
    backlog: Event[];
    closeAfterBacklog: boolean;
  }): ReadableStream<Uint8Array> {
    let subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of args.backlog) {
          controller.enqueue(encodeEventLine(event));
        }

        if (args.closeAfterBacklog) {
          controller.close();
          return;
        }

        subscriber = controller;
        this.subscribers.add(controller);
      },
      cancel: () => {
        if (subscriber != null) {
          this.subscribers.delete(subscriber);
        }
      },
    });
  }

  publish(event: Event) {
    const chunk = encodeEventLine(event);

    for (const subscriber of this.subscribers) {
      try {
        subscriber.enqueue(chunk);
      } catch {
        this.subscribers.delete(subscriber);
      }
    }
  }

  closeAll() {
    for (const subscriber of this.subscribers) {
      try {
        subscriber.close();
      } catch {}
    }

    this.subscribers.clear();
  }
}

function encodeEventLine(event: Event) {
  return textEncoder.encode(`${JSON.stringify(event)}\n`);
}
