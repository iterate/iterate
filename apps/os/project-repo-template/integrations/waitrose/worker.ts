import { WorkerEntrypoint } from "cloudflare:workers";
import { waitroseClient } from "./client.ts";

/**
 * The Waitrose integration entrypoint — the reference USERSPACE integration:
 * project-owned code mounted once into the integrations collection with
 * `provideCapability({ path: ["integrations", "waitrose"] })` (the exact
 * recipe is in ./README.md) and then addressed like any built-in, at fully
 * qualified connection paths:
 *
 *   await itx.integrations.waitrose.mum.shoppingContext();
 *   await itx.integrations.waitrose.mum.trolley();
 *
 * Mounted at ["integrations", "waitrose"], so the first remaining path segment
 * is the CONNECTION and the rest is the client method path — the same
 * `/integrations/<slug>/<connection>` address shape as built-ins. The mount
 * uses `flattenNestedPaths`, so every dotted call arrives here as ONE
 * `invokeCapability({ path, args })` and is dispatched in userspace.
 */
export class WaitroseIntegration extends WorkerEntrypoint {
  async invokeCapability({ args = [], path }: { args?: unknown[]; path: string[] }) {
    const [connection, ...rest] = path;
    if (!connection || rest.length === 0) {
      throw new Error(
        "waitrose expects <connection>.<method>, e.g. itx.integrations.waitrose.mum.shoppingContext()",
      );
    }
    // The session secret is addressed per connection and NEVER read here: the
    // bearer is a getSecret placeholder that project egress routes to the
    // secret's own Durable Object, which substitutes the session token (and
    // re-logins on 401). This code cannot see its tokens.
    const client = waitroseClient({
      authorization: `Bearer getSecret({ path: "/secrets/integrations/waitrose/${connection}/session", field: "accessToken" })`,
      baseUrl: baseUrlFromProps(this.ctx.props),
    });
    let receiver: unknown = client;
    for (const segment of rest.slice(0, -1)) receiver = Reflect.get(Object(receiver), segment);
    const method = Reflect.get(Object(receiver), rest.at(-1)!);
    if (typeof method !== "function") {
      throw new Error(`waitrose client has no method ${rest.join(".")}`);
    }
    return await Reflect.apply(method, receiver, args);
  }
}

/** The mount recipe may pass `props: { baseUrl }` on the worker ref to point
 * the client at a stand-in (the platform e2e uses its dummy-petshop fixture);
 * no props means the real Waitrose. */
function baseUrlFromProps(props: unknown): string | undefined {
  const baseUrl = (props as { baseUrl?: unknown } | null | undefined)?.baseUrl;
  return typeof baseUrl === "string" ? baseUrl : undefined;
}
