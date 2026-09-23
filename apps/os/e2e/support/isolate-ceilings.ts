// e2e/support/isolate-ceilings.ts — what the two ceilings files share: the MiB, a payload of one letter, the
// reset detector, a settle-to-outcome helper and the OOM-ing processor source. They live apart so the
// suite's longest row runs beside the rest instead of after it.

export const MiB = 1024 * 1024;

export const blob = (chars: number): string => "q".repeat(chars);

export const isDurableObjectReset = (e: any): boolean =>
  e != null &&
  (e.durableObjectReset === true ||
    /isolate exceeded its memory limit and was reset/i.test(String(e.message ?? e)));

export const settle = <T>(p: Promise<T>): Promise<{ ok: true; v: T } | { ok: false; e: any }> =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  );

export const OOMER_SOURCE = {
  "cap.js": `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Oomer extends WorkerEntrypoint {
  async ping() { return "pong"; }
  async oom() { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }
}`,
};
