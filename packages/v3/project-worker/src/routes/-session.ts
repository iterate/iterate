// Safe display fields only: no browser token or opaque cookie enters page data.
import { createServerFn } from "@tanstack/react-start";
import { issuerSessionOf } from "../control-plane.ts";
import { consoleContext } from "./-console-context.ts";

export const issuerOf = createServerFn({ method: "GET" })
  .middleware([consoleContext])
  .handler(async ({ context }) => {
    const session = await issuerSessionOf(context.env, context.request);
    return session && { sub: session.sub, email: session.email };
  });
