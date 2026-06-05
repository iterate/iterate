import { RpcTarget } from "cloudflare:workers";

type StreamEvent = {
  type: string;
  payload: unknown;
  offset?: number;
};

export class StreamsCapability extends RpcTarget {
  readonly #events = new Map<string, StreamEvent[]>();

  get(path: string) {
    return new StreamCapability(this.#events, path);
  }

  async append(input: { streamPath: string; event: { type: string; payload: unknown } }) {
    const stream = this.get(input.streamPath);
    return await stream.append(input.event);
  }

  async read(input: { streamPath: string; afterOffset?: number | "start" }) {
    const stream = this.get(input.streamPath);
    return await stream.read(input.afterOffset ?? "start");
  }
}

class StreamCapability extends RpcTarget {
  constructor(
    private readonly events: Map<string, StreamEvent[]>,
    private readonly path: string,
  ) {
    super();
  }

  async append(event: { type: string; payload: unknown }) {
    const bucket = this.events.get(this.path) ?? [];
    const stored = { ...event, offset: bucket.length + 1 };
    bucket.push(stored);
    this.events.set(this.path, bucket);
    return stored;
  }

  async read(afterOffset: number | "start") {
    const bucket = this.events.get(this.path) ?? [];
    if (afterOffset === "start") return [...bucket];
    return bucket.filter((event) => (event.offset ?? 0) > afterOffset);
  }
}

export class ProjectCapability extends RpcTarget {
  constructor(private readonly projectId: string) {
    super();
  }

  async describe() {
    return {
      id: this.projectId,
      slug: `project-${this.projectId}`,
    };
  }
}
