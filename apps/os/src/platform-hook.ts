// platform-hook.ts — THE PLATFORM HOOK: the platform's own subscriber, handed every durable event of
// a project context, one call each — a deployment's birth events give each project context its
// fan-out row (app-config.ts `contextBirthEvents`). The built-in (context/built-ins.ts
// `platformHook`) answers the delivery loop alone and hands each event here with the worker's
// bindings, as every platform built-in holds them. It does nothing with an event yet: a platform
// feature that reacts to a project's events starts here.
import type { StreamEvent } from "iterate/stream/processor";
import type { BuildBuiltInsDeps } from "./context/built-ins.ts";

// oxlint-disable-next-line iterate/no-single-use-helpers -- empty until a platform feature reacts to a project's events: this module is where one starts, with the bindings passed in
export async function deliverToPlatformHook(
  _env: BuildBuiltInsDeps["env"],
  _event: StreamEvent,
): Promise<void> {}
