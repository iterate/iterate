import { WorkerEntrypoint } from "cloudflare:workers";
import {
  StreamPath,
  type Event,
  type EventInput,
  type StreamCursor,
} from "@iterate-com/shared/streams/types";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { AppConfig } from "~/app.ts";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";
import { resolveStreamPath } from "~/stream-paths.ts";

export type StreamApiProps = {
  /**
   * Default stream path for this RPC capability. If a method omits
   * `streamPath`, it operates on this bound stream.
   */
  streamPath?: StreamPath;
};

export class StreamApi extends WorkerEntrypoint<Env, StreamApiProps> {
  async append(args: { event: EventInput; streamPath?: string }): Promise<Event> {
    const eventsClient = this.createEventsClient();
    const path = this.resolveStreamPath(args.streamPath);
    const result = await eventsClient.append({
      path,
      event: args.event,
    });
    return result.event;
  }

  async read(
    args: {
      streamPath?: string;
      afterOffset?: number | "start" | "end";
      beforeOffset?: number | "start" | "end";
    } = {},
  ): Promise<Event[]> {
    const events: Event[] = [];
    const stream = await this.createEventsClient().stream({
      path: this.resolveStreamPath(args.streamPath),
      afterOffset: toEventsCursor(args.afterOffset),
      beforeOffset: toEventsCursor(args.beforeOffset ?? "end"),
    });

    for await (const event of stream) {
      events.push(event);
    }

    return events;
  }

  async *subscribe(
    args: {
      streamPath?: string;
      afterOffset?: number | "start" | "end";
    } = {},
  ): AsyncIterable<Event> {
    const stream = await this.createEventsClient().stream({
      path: this.resolveStreamPath(args.streamPath),
      afterOffset: toEventsCursor(args.afterOffset),
    });

    for await (const event of stream) {
      yield event;
    }
  }

  private createEventsClient() {
    const config = parseAppConfigFromEnv({
      configSchema: AppConfig,
      prefix: "APP_CONFIG_",
      env: this.env,
    });

    return createEventsOrpcClient({
      baseUrl: config.eventsBaseUrl,
      projectId: config.eventsProjectSlug,
    });
  }

  private resolveStreamPath(path: string | undefined): StreamPath {
    return resolveStreamPath({ currentStreamPath: this.ctx.props.streamPath, streamPath: path });
  }
}

function toEventsCursor(value: number | "start" | "end" | undefined): StreamCursor | undefined {
  return typeof value === "number" && value <= 0 ? "start" : value;
}
