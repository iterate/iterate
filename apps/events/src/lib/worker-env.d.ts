import type { worker } from "../../alchemy.run.ts";
import type { StreamDurableObject } from "~/durable-objects/stream.ts";

// Reuse the Durable Object's own method signatures rather than re-declaring
// them by hand here. `Pick` projects only the RPC methods we call, which keeps
// this override in sync with `StreamDurableObject` while avoiding the much
// larger generated stub type. This is the same containment strategy Cloudflare
// maintainers have suggested for awkward env bindings in upstream threads.
type StreamRpcStub = Pick<
  StreamDurableObject,
  "append" | "destroy" | "history" | "stream" | "getState"
>;
type BaseEnv = typeof worker.Env;

// `typeof worker.Env` gives `STREAM` the full generated
// `DurableObjectStub<StreamDurableObject>` type. That type is correct, but in
// this app it expands through Cloudflare's RPC helper types deeply enough that
// normal calls like `env.STREAM.getByName(path).append(...)` trigger
// "Type instantiation is excessively deep and possibly infinite" (see
// https://github.com/cloudflare/workerd/issues/3063).
//
// Override only this local binding so `get()` / `getByName()` return the small
// method surface we actually call. Runtime behavior is unchanged; this is
// purely a TypeScript escape hatch for the generated type.
type StreamNamespace = Omit<BaseEnv["STREAM"], "get" | "getByName"> & {
  get(id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions): StreamRpcStub;
  getByName(name: string, options?: DurableObjectNamespaceGetDurableObjectOptions): StreamRpcStub;
};

export type CloudflareEnv = Omit<BaseEnv, "STREAM"> & {
  STREAM: StreamNamespace;
};

declare global {
  type Env = CloudflareEnv;
}

declare module "cloudflare:workers" {
  namespace Cloudflare {
    export interface Env extends CloudflareEnv {}
  }
}
