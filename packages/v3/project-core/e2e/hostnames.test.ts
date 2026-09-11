import assert from "node:assert/strict";
import { lookup, Resolver } from "node:dns";
import { test } from "node:test";
import { Agent, fetch } from "undici";
import { base, call, crypto, setting, timeout } from "./support.ts";

test(
  "routes platform and custom hosts into the same context and fetch policy",
  { skip: !base, timeout },
  async () => {
    const dashboard = new URL(base!);
    const local = dashboard.hostname === "localhost";
    const platform = local ? "localhost" : process.env.E2E_PROJECT_HOSTNAME_BASE;
    const customer = local ? "customer.localhost" : process.env.E2E_CUSTOM_HOSTNAME;
    assert.ok(platform, "Set E2E_PROJECT_HOSTNAME_BASE to the deployed wildcard domain");
    assert.ok(customer, "Set E2E_CUSTOM_HOSTNAME to the deployed custom domain");
    const project = "project-core-ingress-demo";
    const other = "project-core-ingress-exact";
    const dnsServer = process.env.E2E_DNS_SERVER;
    const resolver = new Resolver();
    if (dnsServer) resolver.setServers([dnsServer]);
    // Browsers resolve *.localhost specially; supply that DNS behavior to Node's real HTTP client.
    const dispatcher = new Agent({
      connect: {
        lookup(hostname, options, callback) {
          // Query real DNS directly, not the OS host cache; E2E_DNS_SERVER selects the resolver.
          if (!local)
            return resolver.resolve4(hostname, (error, addresses) => {
              if (error) return callback(error, [], 4);
              callback(
                null,
                options.all ? addresses.map((address) => ({ address, family: 4 })) : addresses[0]!,
                4,
              );
            });
          return lookup(
            hostname.endsWith(".localhost") ? "localhost" : hostname,
            options,
            callback,
          );
        },
      },
    });
    try {
      for (const id of [project, other]) {
        await call(
          id,
          ["append"],
          [
            setting(crypto.randomUUID(), "mount/fetch", {
              kind: "worker",
              source: {
                modules: {
                  "main.js": `export default { async fetch(request, env) {
          const scope = await env.ITX.get();
          const state = await scope.inspect();
          return Response.json({ context: state.context.name, url: request.url,
            app: request.headers.get('x-iterate-app'), forged: request.headers.get('x-core-terminal') });
        } }`,
                },
              },
            }),
          ],
        );
      }
      const cases = [
        { host: `demo.${platform}`, id: project, app: null },
        { host: `docs--demo.${platform}`, id: project, app: "docs" },
        { host: `my-project.${platform}`, id: project, app: null },
        { host: `tasks--my-project.${platform}`, id: project, app: "tasks" },
        { host: `docs--my-project.${platform}`, id: other, app: null },
        { host: customer, id: project, app: null },
        { host: `anything.${customer}`, id: project, app: "anything" },
        { host: `docs.${customer}`, id: project, app: "docs" },
        { host: `preview-123.${customer}`, id: project, app: "preview-123" },
      ];
      for (const { host, id, app } of cases) {
        const url = `${dashboard.protocol}//${host}${local ? `:${dashboard.port}` : ""}/notes?q=1`;
        const response = await fetch(url, {
          dispatcher,
          signal: AbortSignal.timeout(timeout),
          headers: {
            "x-iterate-app": "forged",
            "x-itx-project-id": "forged",
            "x-core-terminal": "forged",
          },
        });
        assert.equal(response.status, 200, `${url}: ${await response.clone().text()}`);
        assert.deepEqual(await response.json(), { context: `${id}/`, url, app, forged: null });
      }
      const unknown = await fetch(
        `${dashboard.protocol}//unknown.${platform}${local ? `:${dashboard.port}` : ""}/`,
        {
          dispatcher,
          signal: AbortSignal.timeout(timeout),
        },
      );
      assert.equal(unknown.status, 421);
      await unknown.body?.cancel();
    } finally {
      await dispatcher.close();
    }
  },
);
