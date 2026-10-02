import { createStart } from "@tanstack/react-start";
import { documentBasePath } from "@iterate-com/ui/apps/base-path";

/** A server function the browser calls (the root loader's, when the router reloads) goes under the
 *  page's base path: the build's bare `/_serverFn/…` would leave a proxied Docs for the platform
 *  it shares an origin with (@iterate-com/ui/apps/base-path). The server render calls server functions directly. */
export const startInstance = createStart(() => ({
  serverFns: {
    fetch: (input, init) =>
      fetch(typeof input === "string" ? `${documentBasePath()}${input}` : input, init),
  },
}));
