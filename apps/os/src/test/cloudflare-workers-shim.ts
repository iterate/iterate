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
export const env = {};

export type RecordedSpan = {
  attributes: Record<string, unknown>;
  name: string;
};

export const recordedSpans: RecordedSpan[] = [];

export function resetRecordedSpans() {
  recordedSpans.length = 0;
}

export const tracing = {
  enterSpan: <T>(
    name: string,
    callback: (span: { setAttribute(name: string, value: unknown): void }) => T,
  ): T => {
    const record: RecordedSpan = { attributes: {}, name };
    recordedSpans.push(record);
    return callback({
      setAttribute: (attribute, value) => {
        record.attributes[attribute] = value;
      },
    });
  },
};
