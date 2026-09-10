// -session.ts (the `-` prefix: not a route) — THE ONE session read every route shares: the display
// fields of the `__Host-itx-control-plane-session` cookie (control-plane.ts `consoleSessionOf`,
// principal.ts verifies it) — never the cookie itself: what a loader returns is dehydrated into the
// page. Runs on the server for SSR and for a client navigation alike (the fn's own fetch carries the
// cookie); `context` is what the worker handed the Start entry (-console-context.ts).
import { createServerFn } from "@tanstack/react-start";
import { consoleSessionOf } from "../control-plane.ts";
import { consoleContext } from "./-console-context.ts";

export const sessionOf = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .handler(async ({ context }) => {
    const session = await consoleSessionOf(context.env, context.request);
    return session && { sub: session.sub, email: session.email };
  });
