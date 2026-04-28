import { WorkerEntrypoint } from "cloudflare:workers";
import {
  StreamPath,
  type Event,
  type EventInput,
  type StreamCursor,
} from "@iterate-com/events-contract";
import { parseAppConfigFromEnv } from "@iterate-com/shared/apps/config";
import { AppConfig } from "~/app.ts";
import { createEventsOrpcClient } from "~/lib/events-orpc-client.ts";

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
      afterOffset?: StreamCursor;
      beforeOffset?: StreamCursor;
    } = {},
  ): Promise<Event[]> {
    const events: Event[] = [];
    const stream = await this.createEventsClient().stream({
      path: this.resolveStreamPath(args.streamPath),
      afterOffset: args.afterOffset,
      beforeOffset: args.beforeOffset ?? "end",
    });

    for await (const event of stream) {
      events.push(event);
    }

    return events;
  }

  async *subscribe(
    args: {
      streamPath?: string;
      afterOffset?: StreamCursor;
    } = {},
  ): AsyncIterable<Event> {
    const stream = await this.createEventsClient().stream({
      path: this.resolveStreamPath(args.streamPath),
      afterOffset: args.afterOffset,
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
      projectSlug: config.eventsProjectSlug,
    });
  }

  private resolveStreamPath(path: string | undefined): StreamPath {
    const boundPath = this.ctx.props.streamPath;
    if (path == null) {
      if (boundPath == null) {
        throw new Error(
          "StreamApi operation requires a streamPath because no streamPath prop is bound.",
        );
      }

      return StreamPath.parse(boundPath);
    }

    if (path.startsWith("/")) {
      return StreamPath.parse(path);
    }

    if (boundPath == null) {
      throw new Error("Relative StreamApi operation requires a bound streamPath prop.");
    }

    return StreamPath.parse(boundPath === "/" ? `/${path}` : `${boundPath}/${path}`);
  }
}
