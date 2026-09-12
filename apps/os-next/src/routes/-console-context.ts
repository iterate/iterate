// -console-context.ts (the `-` prefix: not a route) — THE ONE typed door to the worker for every server
// function: the context the worker handed the Start entry (control-plane.ts `consoleHandler` →
// `ConsoleRequestContext`: the env with the provider's `OAUTH_PROVIDER` on it, the execution
// context, the request — the page's under SSR, the function's own fetch on a client call). A Start
// function middleware, so `createServerFn().middleware([consoleContext]).handler(({ context }) => …)`
// sees it typed; the cast is here, once (control-plane.ts says why not Start's `Register`).
import { createMiddleware } from "@tanstack/react-start";
import type { ConsoleRequestContext } from "../control-plane.ts";

export const consoleContext = createMiddleware({ type: "function" }).server(({ next, context }) =>
  next({ context: context as unknown as ConsoleRequestContext }),
);
