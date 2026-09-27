import { createStart } from "@tanstack/react-start";
import { documentBasePath } from "./base-path.ts";

/** A server function the browser calls (the root loader's, when the router reloads) goes under the
 *  page's base path: the build's bare `/_serverFn/…` would leave a proxied Notes for the platform
 *  it shares an origin with (base-path.ts). The server render calls server functions directly. */
export const startInstance = createStart(() => ({
  serverFns: {
    fetch: (input, init) =>
      fetch(typeof input === "string" ? `${documentBasePath()}${input}` : input, init),
  },
}));
