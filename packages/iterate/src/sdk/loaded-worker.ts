// sdk/loaded-worker.ts — what every LOADED worker evaluates before its own main module, and the
// platform's own isolate never does (core/os context/module-resolution.ts `enteredThroughPlatform`).
// Its outbound `fetch` carries the cause it runs under (../cause.ts), and every `WorkerEntrypoint`
// it exports, an SDK host or not, gets:
//   callWithCause(cause, steps) — the walk the platform makes every call but `fetch` through
//                                 (call-with-cause.ts), so a method runs under its own call's cause;
//   getItx()                    — `using itx = this.getItx()`: `env.ITX`'s scope, released when the
//                                 block ends (itx-scope.ts).
// Workers RPC reaches anything on the prototype, `getItx` included, so the platform refuses a
// caller's step by that name (`walkUnderCause`, core/os built-ins.ts `workers`). Small, and imports
// no host: every loaded isolate's cold start evaluates it.

import { WorkerEntrypoint } from "cloudflare:workers";
import { carryCauseOnFetch } from "../cause.ts";
import { walkUnderCause, type RpcSteps } from "./call-with-cause.ts";
import { itxScope } from "./itx-scope.ts";

carryCauseOnFetch();

// Non-enumerable data properties (defineProperties' default); an SDK host's own shadow them.
Object.defineProperties(WorkerEntrypoint.prototype, {
  callWithCause: {
    value(this: WorkerEntrypoint, cause: unknown, steps: RpcSteps) {
      return walkUnderCause(this, cause, steps);
    },
    writable: true,
    configurable: true,
  },
  getItx: {
    value(this: { env: { ITX: { get(): unknown } } }) {
      return itxScope(this.env.ITX);
    },
    writable: true,
    configurable: true,
  },
});
