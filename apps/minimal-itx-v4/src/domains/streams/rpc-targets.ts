import { env, RpcTarget } from "cloudflare:workers";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import type { ItxAuth } from "../itx/types.ts";
import type { Stream, StreamCollection } from "./types.ts";

export class StreamRpcTarget extends RpcTarget implements Stream {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null; path: string }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get durableObjectStub() {
    return env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.props.projectId,
        path: this.props.path,
      }),
    );
  }

  append(...events: Parameters<Stream["append"]>) {
    return this.durableObjectStub.append(...events);
  }

  at(path: Parameters<Stream["at"]>[0]) {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path: resolveStreamPath(this.props.path, path),
    });
  }

  getEvent(args: Parameters<Stream["getEvent"]>[0]) {
    return this.durableObjectStub.getEvent(args);
  }

  getEvents(args?: Parameters<Stream["getEvents"]>[0]) {
    return this.durableObjectStub.getEvents(args);
  }

  waitForEvent(args: Parameters<Stream["waitForEvent"]>[0]) {
    return this.durableObjectStub.waitForEvent(args);
  }

  getProcessorRuntimeState(args: Parameters<Stream["getProcessorRuntimeState"]>[0]) {
    return this.durableObjectStub.getProcessorRuntimeState(args);
  }

  runtimeState() {
    return this.durableObjectStub.runtimeState();
  }

  subscribe(args: Parameters<Stream["subscribe"]>[0]) {
    return this.durableObjectStub.subscribe(
      args as Parameters<typeof this.durableObjectStub.subscribe>[0],
    );
  }
}

export class StreamCollectionRpcTarget extends RpcTarget implements StreamCollection {
  constructor(readonly props: { auth: ItxAuth; projectId: string | null }) {
    super();
    props.auth.assertCanAccessProject(props.projectId);
  }

  get(path: string) {
    return new StreamRpcTarget({
      auth: this.props.auth,
      projectId: this.props.projectId,
      path,
    });
  }
}

function resolveStreamPath(basePath: string, streamPath: string): string {
  const segments = streamPath.startsWith("/") ? [] : basePath.split("/").filter(Boolean);
  for (const segment of streamPath.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(
          `stream path "${streamPath}" escapes the stream root (resolved from "${basePath}")`,
        );
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
