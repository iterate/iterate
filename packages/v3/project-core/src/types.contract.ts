import type { Scope } from "./types.ts";

// Compile-only: a pipelined capability keeps the next declared RPC method.
type PipelinedReadEvents = ReturnType<ReturnType<Scope["cd"]>["readEvents"]>;
type Expect<T extends true> = T;
type _ReadEventsExists = Expect<[PipelinedReadEvents] extends [never] ? false : true>;
type _PipelinedWorkerFetch = ReturnType<ReturnType<Scope["load"]>["fetch"]>;

// @ts-expect-error Scope has no undeclared remote method.
type _NoImaginaryMethod = ReturnType<Scope["cd"]>["imaginary"];
