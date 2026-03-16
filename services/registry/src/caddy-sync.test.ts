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
    expect(rendered).toContain("handle @route_example_hosts {");
    expect(rendered).toContain("iterate_upstream 127.0.0.1:19040");
    expect(rendered).toContain("reverse_proxy 127.0.0.1:19040 {");
  });

  test("renders extra caddy directives inline for FRP routes", () => {
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

    expect(rendered).toContain('# extraCaddyDirectives: ["stream_close_delay 5m"]');
    expect(rendered).toContain("reverse_proxy 127.0.0.1:27000 {");
    expect(rendered).toContain("stream_close_delay 5m");
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
      iterateIngressDefaultService: "registry",
      routes: [{ host: "registry.iterate.localhost", target: "127.0.0.1:17310" }],
    });

    expect(rendered).toContain(
      "@route_registry_hosts host registry.iterate.localhost registry.my-proj.iterate.app registry__my-proj.iterate.app my-proj.iterate.app",
    );
  });

  test("renders auth directives inline for OpenObserve routes", () => {
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

    expect(rendered).toContain("handle @route_openobserve_hosts {");
    expect(rendered).toContain(
      'header_up Authorization "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM="',
    );
    expect(rendered).toContain("iterate_service_slug openobserve");
  });

  test("emits tags and metadata as compact comments", () => {
    const rendered = renderRoutesFragmentForTest({
      iterateIngressHost: "my-proj.iterate.app",
      routes: [
        {
          host: "registry.iterate.localhost",
          target: "127.0.0.1:17310",
          tags: ["seeded", "registry", "openapi", "sqlite"],
          metadata: { source: "registry-seed", title: "Registry Service" },
        },
      ],
    });

    expect(rendered).toContain("# tags: seeded, registry, openapi, sqlite");
    expect(rendered).toContain('# metadata: {"source":"registry-seed","title":"Registry Service"}');
  });
});
