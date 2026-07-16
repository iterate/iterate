// Minimal Node-side stand-in for the `cloudflare:workers` module, aliased in
// apps/os/vitest.config.ts. It exists so the pure itx core (src/itx/itx.ts)
// — whose ONLY platform dependency is the RpcTarget base class — can be unit
// tested without workerd (src/itx/itx.test.ts). The tracing stand-in is just
// enough for observability unit tests; the preview proof still exercises the
// real Workers implementation.

export class RpcTarget {}
export class RpcStub {}
export class RpcPromise {}
export class RpcProperty {}
export class ServiceStub {}
// Base classes some VALUE-imported modules extend at load time (e.g.
// rpc-targets.ts pulls in egress.ts's WorkerEntrypoint subclass). Class
// bodies never run in node tests — the subclasses just need a constructable
// base so their module can evaluate.
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  env!: Env;
  ctx!: {
    props: Props;
    exports: Record<string, unknown>;
    waitUntil(promise: Promise<unknown>): void;
  };
}
export class DurableObject {}
export const env = {};

export type RecordedSpan = {
  attributes: Record<string, unknown>;
  name: string;
};

export const recordedSpans: RecordedSpan[] = [];
export const activeSpans = new Set<RecordedSpan>();

export function resetRecordedSpans() {
  recordedSpans.length = 0;
  activeSpans.clear();
}

export const tracing = {
  enterSpan: <T>(
    name: string,
    callback: (span: { setAttribute(name: string, value: unknown): void }) => T,
  ): T => {
    const record: RecordedSpan = { attributes: {}, name };
    recordedSpans.push(record);
    activeSpans.add(record);
    try {
      const result = callback({
        setAttribute: (attribute, value) => {
          record.attributes[attribute] = value;
        },
      });
      if (result instanceof Promise) {
        return result.finally(() => activeSpans.delete(record)) as T;
      }
      activeSpans.delete(record);
      return result;
    } catch (error) {
      activeSpans.delete(record);
      throw error;
    }
  },
};
