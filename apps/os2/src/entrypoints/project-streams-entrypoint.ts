import { WorkerEntrypoint } from "cloudflare:workers";
import {
  type Event,
  type EventInput,
  type StreamCursor,
  StreamPath,
} from "@iterate-com/events-contract";
import { createEventsClient } from "~/lib/events-client.ts";

type ProjectStreamsEntrypointProps = {
  eventsBaseUrl: string;
  projectId: string;
};

type ProjectStreamPathInput = {
  path: string;
};

type ProjectStreamsAppendInput = ProjectStreamPathInput & {
  event: EventInput;
};

type ProjectStreamsReadInput = ProjectStreamPathInput & {
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
};

type ProjectStreamsStreamInput = ProjectStreamPathInput & {
  afterOffset?: StreamCursor;
  beforeOffset?: StreamCursor;
};

type ProjectStreamsListChildrenInput = ProjectStreamPathInput;

export class ProjectStreamsEntrypoint extends WorkerEntrypoint<
  Record<string, unknown>,
  ProjectStreamsEntrypointProps
> {
  async append(input: ProjectStreamsAppendInput): Promise<Event> {
    const { event } = await this.createEventsClient().append({
      path: this.resolveProjectPath(input),
      event: input.event,
    });
    return event;
  }

  async read(input: ProjectStreamsReadInput): Promise<Event[]> {
    const events: Event[] = [];
    const stream = await this.createEventsClient().stream({
      path: this.resolveProjectPath(input),
      afterOffset: input.afterOffset,
      beforeOffset: input.beforeOffset ?? "end",
    });

    for await (const event of stream) {
      events.push(event);
    }

    return events;
  }

  async stream(input: ProjectStreamsStreamInput): Promise<Response> {
    const url = this.eventsApiUrl({
      path: this.resolveProjectPath(input),
      route: "streams",
    });
    if (input.afterOffset != null) url.searchParams.set("afterOffset", String(input.afterOffset));
    if (input.beforeOffset != null) {
      url.searchParams.set("beforeOffset", String(input.beforeOffset));
    }

    return await fetch(url, {
      headers: {
        accept: "text/event-stream",
        "x-iterate-project-id": this.ctx.props.projectId,
      },
    });
  }

  async getState(input: ProjectStreamPathInput) {
    return await this.createEventsClient().getState({
      path: this.resolveProjectPath(input),
    });
  }

  async listChildren(input: ProjectStreamsListChildrenInput) {
    return await this.createEventsClient().listChildren({
      path: this.resolveProjectPath(input),
    });
  }

  private resolveProjectPath(input: ProjectStreamPathInput): StreamPath {
    return resolveProjectStreamPath({
      path: input.path,
      projectId: this.ctx.props.projectId,
    });
  }

  private eventsApiUrl(input: { path: StreamPath; route: "streams" | "streams/__state" }) {
    const url = new URL(`/api/${input.route}/`, this.ctx.props.eventsBaseUrl);
    url.pathname = `${url.pathname}${streamPathToApiSplat(input.path)}`;
    return url;
  }

  private createEventsClient() {
    return createEventsClient(this.ctx.props.eventsBaseUrl);
  }
}

export function resolveProjectStreamPath(input: { path: string; projectId: string }): StreamPath {
  const trimmedPath = input.path.trim();
  if (!trimmedPath) {
    throw new Error("Stream path is required.");
  }

  const path = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  const projectRoot = `/projects/${input.projectId}`;
  if (path === projectRoot || path.startsWith(`${projectRoot}/`)) {
    return StreamPath.parse(path);
  }

  if (path === "/") {
    return StreamPath.parse(projectRoot);
  }

  if (path.startsWith("/projects/")) {
    throw new Error(`Stream path must belong to project ${input.projectId}.`);
  }

  return StreamPath.parse(`${projectRoot}${path}`);
}

function streamPathToApiSplat(path: StreamPath) {
  return path === "/" ? "%2F" : path.replace(/^\/+/, "");
}
