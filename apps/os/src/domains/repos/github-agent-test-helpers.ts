import type { Stream } from "../../itx-api.generated.ts";
import type { StreamEvent, StreamEventInput } from "../streams/schemas.ts";
import { emptyStreamRuntimeState } from "../streams/test-helpers.ts";

/** Minimal in-memory stream network shared by the GitHub router and agent tests. */
export class MemoryStreamNetwork {
  readonly streams = new Map<string, MemoryStream>();

  get(path: string): MemoryStream {
    let stream = this.streams.get(path);
    if (stream === undefined) {
      stream = new MemoryStream(this, path);
      this.streams.set(path, stream);
    }
    return stream;
  }

  eventsAt(path: string): StreamEvent[] {
    return this.streams.get(path)?.events ?? [];
  }
}

export class MemoryStream implements Stream {
  events: StreamEvent[] = [];

  async __describe() {
    return { instructions: "in-memory test stream", types: "", children: {} };
  }

  async kill(): Promise<void> {}

  constructor(
    readonly network: MemoryStreamNetwork,
    readonly path: string,
  ) {}

  async append(...inputs: StreamEventInput[]): Promise<StreamEvent[]> {
    return inputs.map((input) => {
      const existing =
        input.idempotencyKey === undefined
          ? undefined
          : this.events.find((event) => event.idempotencyKey === input.idempotencyKey);
      if (existing !== undefined) return existing;
      const event: StreamEvent = {
        ...input,
        createdAt: new Date(this.events.length + 1).toISOString(),
        offset: this.events.length + 1,
        path: this.path,
      };
      this.events.push(event);
      return event;
    });
  }

  async appendAck(...inputs: StreamEventInput[]): Promise<void> {
    await this.append(...inputs);
  }

  async appendOffsets(...inputs: StreamEventInput[]): Promise<number[]> {
    return (await this.append(...inputs)).map((event) => event.offset);
  }

  at(path: string): Stream {
    return this.network.get(path);
  }

  async getEvent(): Promise<StreamEvent | undefined> {
    return undefined;
  }

  async getEvents(input: Parameters<Stream["getEvents"]>[0] = {}): Promise<StreamEvent[]> {
    const { afterOffset = 0, limit = 500 } = input;
    const beforeOffset = input.beforeOffset ?? Number.MAX_SAFE_INTEGER;
    return this.events
      .filter((event) => event.offset > afterOffset)
      .filter((event) => event.offset < beforeOffset)
      .filter(
        (event) =>
          input.eventTypes === undefined ||
          input.eventTypes.includes("*") ||
          input.eventTypes.includes(event.type),
      )
      .slice(0, limit);
  }

  readEvents(input: Parameters<Stream["readEvents"]>[0] = {}) {
    let afterOffset = input.afterOffset ?? 0;
    return {
      next: async () => {
        const page = await this.getEvents({ ...input, afterOffset });
        afterOffset = page.at(-1)?.offset ?? afterOffset;
        return page;
      },
      [Symbol.dispose]() {},
    };
  }

  async waitForEvent(): Promise<StreamEvent> {
    throw new Error("MemoryStream does not implement waitForEvent().");
  }

  async getProcessorRuntimeState(): Promise<null> {
    return null;
  }

  async head() {
    return { createdAt: this.events[0]?.createdAt, maxOffset: this.events.at(-1)?.offset ?? 0 };
  }

  async runtimeState() {
    return emptyStreamRuntimeState();
  }

  async subscribe(): Promise<never> {
    throw new Error("MemoryStream does not implement subscribe().");
  }

  async crossPostTo(): Promise<never> {
    throw new Error("MemoryStream does not implement crossPostTo().");
  }

  async removeCrossPost(): Promise<never> {
    throw new Error("MemoryStream does not implement removeCrossPost().");
  }
}

type ProcessorLike = {
  ingest(input: { events: readonly StreamEvent[]; streamMaxOffset: number }): Promise<void>;
};

export async function deliverNewEvents(input: {
  cursors: Map<object, number>;
  processor: ProcessorLike;
  stream: MemoryStream;
}) {
  const cursor = input.cursors.get(input.processor) ?? 0;
  const events = input.stream.events.slice(cursor);
  input.cursors.set(input.processor, input.stream.events.length);
  if (events.length === 0) return;
  await input.processor.ingest({ events, streamMaxOffset: input.stream.events.length });
}

export const GITHUB_LINK = {
  connection: "install-789",
  installationId: "789",
  owner: "acme",
  repo: "widgets",
};

/** One captured GitHub webhook delivery, in the connection-stream envelope. */
export function webhookPayload(
  body: Record<string, unknown>,
  githubEvent = "pull_request",
): Record<string, unknown> {
  return {
    body,
    headers: { "content-type": "application/json", githubEvent },
    installationId: "789",
  };
}

export function pullRequestBody(input: {
  action?: string;
  body?: string;
  comment?: {
    authorAssociation?: string;
    body: string;
    id?: number;
    senderLogin?: string;
    senderType?: string;
  };
  draft?: boolean;
  headSha?: string;
  labels?: string[];
  number?: number;
  title?: string;
}): Record<string, unknown> {
  const number = input.number ?? 7;
  return {
    action: input.action ?? (input.comment === undefined ? "opened" : "created"),
    ...(input.comment === undefined
      ? {
          pull_request: {
            number,
            title: input.title ?? "Add widgets",
            author_association: "MEMBER",
            state: "open",
            draft: input.draft ?? false,
            head: {
              ref: "feature",
              sha: input.headSha ?? "head-abc",
              repo: { name: "widgets-fork", owner: { login: "author" } },
            },
            base: { ref: "main", sha: "base-abc" },
            body: input.body ?? "PR description",
            labels: (input.labels ?? []).map((name) => ({ name })),
            html_url: `https://github.com/acme/widgets/pull/${number}`,
            user: { login: "author" },
          },
        }
      : {
          issue: { number, title: input.title ?? "Add widgets", pull_request: { url: "x" } },
          comment: {
            author_association: input.comment.authorAssociation ?? "MEMBER",
            body: input.comment.body,
            html_url: "https://github.com/x",
            id: input.comment.id ?? 456,
          },
        }),
    sender: {
      login: input.comment?.senderLogin ?? "jonas",
      type: input.comment?.senderType ?? "User",
    },
    repository: { full_name: "acme/widgets" },
  };
}
