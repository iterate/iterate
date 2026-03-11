import { describe, expect, test } from "vitest";
import { renderRoutesFragmentForTest } from "./caddy-sync.ts";

describe("renderRoutesFragmentForTest", () => {
  test("renders one handle with internal + subdomain + dunder hosts", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "my-proj.iterate.app",
      routes: [{ host: "example.iterate.localhost", target: "127.0.0.1:19040" }],
    });

    expect(rendered).toContain(
      "@route_example_hosts host example.iterate.localhost example.my-proj.iterate.app example__my-proj.iterate.app",
    );
    expect(rendered).toContain("# serviceSlug: example");
    expect(rendered).toContain("iterate_upstream 127.0.0.1:19040");
    expect(rendered).not.toContain("iterate_extra_proxy_behavior");
  });

  test("maps FRP route directives to FRP extra proxy behavior", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "my-proj.iterate.app",
      routes: [
        {
          host: "frp.iterate.localhost",
          target: "127.0.0.1:27000",
          caddyDirectives: ["stream_close_delay 5m"],
        },
      ],
    });

    expect(rendered).toContain("iterate_extra_proxy_behavior frp-incantations");
    expect(rendered).toContain("# extraProxyBehavior: frp-incantations");
    expect(rendered).toContain('# extraCaddyDirectives: ["stream_close_delay 5m"]');
    expect(rendered).toContain("iterate_upstream 127.0.0.1:27000");
  });

  test("strips port from ITERATE_INGRESS_HOST for host matching", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "iterate.localhost:12412",
      routes: [{ host: "events.iterate.localhost", target: "127.0.0.1:17320" }],
    });

    expect(rendered).toContain("events.iterate.localhost events__iterate.localhost");
    expect(rendered).not.toContain("iterate.localhost:12412");
  });

  test("routes bare public base host to default ingress service", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "my-proj.iterate.app",
      iterateIngressDefaultService: "home",
      routes: [{ host: "home.iterate.localhost", target: "127.0.0.1:19030" }],
    });

    expect(rendered).toContain(
      "@route_home_hosts host home.iterate.localhost home.my-proj.iterate.app home__my-proj.iterate.app my-proj.iterate.app",
    );
  });

  test("maps auth directives to OpenObserve extra proxy behavior", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "my-proj.iterate.app",
      routes: [
        {
          host: "openobserve.iterate.localhost",
          target: "127.0.0.1:5080",
          caddyDirectives: [
            'header_up Authorization "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="',
          ],
        },
      ],
    });

    expect(rendered).toContain("iterate_extra_proxy_behavior openobserve-incantations");
    expect(rendered).toContain("# extraProxyBehavior: openobserve-incantations");
    expect(rendered).toContain("iterate_service_slug openobserve");
  });

  test("emits tags and metadata as compact comments", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "my-proj.iterate.app",
      routes: [
        {
          host: "docs.iterate.localhost",
          target: "127.0.0.1:19050",
          tags: ["seeded", "docs"],
          metadata: { source: "registry-seed", title: "Docs Service" },
        },
      ],
    });

    expect(rendered).toContain("# tags: seeded, docs");
    expect(rendered).toContain('# metadata: {"source":"registry-seed","title":"Docs Service"}');
  });
});
