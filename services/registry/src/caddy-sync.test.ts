import { describe, expect, test } from "vitest";
import { renderRoutesFragmentForTest } from "./caddy-sync.ts";

describe("renderRoutesFragmentForTest", () => {
  test("renders one handle with internal + subdomain + dunder hosts", () => {
    const rendered = renderRoutesFragmentForTest({
      iteratePublicBaseHost: "my-proj.iterate.app",
      routes: [{ host: "example.iterate.localhost", target: "127.0.0.1:19040" }],
    });

    expect(rendered).toContain(
      "@route_example_hosts host example.iterate.localhost example.my-proj.iterate.app example__my-proj.iterate.app",
    );
    expect(rendered).toContain("reverse_proxy 127.0.0.1:19040 {");
    expect(rendered).toContain("import iterate_cors_openapi");
  });

  test("preserves custom caddy directives in reverse_proxy block", () => {
    const rendered = renderRoutesFragmentForTest({
      iteratePublicBaseHost: "my-proj.iterate.app",
      routes: [
        {
          host: "frp.iterate.localhost",
          target: "127.0.0.1:27000",
          caddyDirectives: ["stream_close_delay 5m"],
        },
      ],
    });

    expect(rendered).toContain("stream_close_delay 5m");
    expect(rendered).toContain("reverse_proxy 127.0.0.1:27000 {");
  });

  test("strips port from ITERATE_PUBLIC_BASE_HOST for host matching", () => {
    const rendered = renderRoutesFragmentForTest({
      iteratePublicBaseHost: "iterate.localhost:12412",
      routes: [{ host: "events.iterate.localhost", target: "127.0.0.1:17320" }],
    });

    expect(rendered).toContain("events.iterate.localhost events__iterate.localhost");
    expect(rendered).not.toContain("iterate.localhost:12412");
  });
});
