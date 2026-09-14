import type { Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { HOSTED_STREAM_HOST_PATH, isHostedStreamPrototypePath } from "./hosted-stream-routing.ts";
import { StreamDurableObject } from "./stream-durable-object.ts";

type HostedAlarmHost = {
  deleteHostedStreamAlarm(input: { logicalName: string }): Promise<void>;
  getHostedStreamAlarm(input: { logicalName: string }): Promise<number | null>;
  setHostedStreamAlarm(input: { atMs: number; logicalName: string }): Promise<void>;
};

/**
 * A real StreamDurableObject running in one child facet. The proxy supplies
 * its logical name and relays only the three native-alarm storage operations
 * to the warm parent. SQLite/KV, WebSockets, facets, and all StreamDO logic
 * remain this child's own state and implementation.
 */
export class HostedStreamPrototypeFacet extends StreamDurableObject {
  /** `alarm` is a platform callback name, not a cross-facet RPC contract. */
  handleHostedAlarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    return this.alarm(alarmInfo);
  }

  constructor(ctx: DurableObjectState, env: Env) {
    const logicalName = readFacetLogicalName(ctx, env);
    const logical = DurableObjectNameCodec.parse(logicalName, { allowNullProjectId: true });
    if (!logical.projectId) throw new Error("hosted stream prototype requires a project id");
    // This is the child Durable Object's own parent-alarm relay; it is not ingress.
    // This same-project StreamDO is the dedicated host. The binding type
    // cannot express its small hosted-alarm RPC surface, so narrow it here.
    // oxlint-disable-next-line iterate/no-raw-durable-object-binding-access
    const host = env.STREAM.getByName(
      DurableObjectNameCodec.stringify({
        path: HOSTED_STREAM_HOST_PATH,
        projectId: logical.projectId,
      }),
    ) as unknown as HostedAlarmHost;
    super(ctx, env, hostedStreamContext(ctx, host, logicalName));
  }
}

function readFacetLogicalName(ctx: DurableObjectState, env: Env): string {
  if (env.DEPLOYMENT_ENV !== "preview_17") {
    throw new Error("hosted stream prototype is only enabled in preview_17");
  }
  if (typeof ctx.id !== "string") {
    throw new Error("hosted stream prototype facet requires its string logical id");
  }
  const logical = DurableObjectNameCodec.parse(ctx.id, { allowNullProjectId: true });
  if (!isHostedStreamPrototypePath(logical.path)) {
    throw new Error(`hosted stream prototype rejects ${logical.path}`);
  }
  return ctx.id;
}

function hostedStreamContext(
  ctx: DurableObjectState,
  host: HostedAlarmHost,
  logicalName: string,
): DurableObjectState {
  const storage = new Proxy(ctx.storage, {
    get(target, property) {
      if (property === "setAlarm") {
        return (atMs: number) => host.setHostedStreamAlarm({ atMs, logicalName });
      }
      if (property === "getAlarm") {
        return () => host.getHostedStreamAlarm({ logicalName });
      }
      if (property === "deleteAlarm") {
        return () => host.deleteHostedStreamAlarm({ logicalName });
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  // The proxy preserves every native context member except the child logical
  // id and the three alarm operations, which must relay through the host.
  // Proxy typing cannot retain DurableObjectState's branded platform shape;
  // its traps below preserve that shape at runtime.
  return new Proxy(ctx, {
    get(target, property) {
      if (property === "id") return { name: logicalName };
      if (property === "storage") return storage;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DurableObjectState;
}
