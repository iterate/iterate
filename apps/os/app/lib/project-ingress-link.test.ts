import { describe, expect, it } from "vitest";
import { buildProjectIngressLink } from "./project-ingress-link.ts";

describe("buildProjectIngressLink", () => {
  it("avoids double slashes when base URL ends with / and path starts with /", () => {
    const url = buildProjectIngressLink({
      baseUrl: "https://3000__mach_01kh90jnk0fk6bzmxnsxcm9fn2.iterate.app/",
      path: "/terminal",
      query: {
        command: "tail -n 200 -f /var/log/pidnap/process/daemon-frontend.log",
        autorun: "true",
      },
    });

    expect(url).toBe(
      "https://3000__mach_01kh90jnk0fk6bzmxnsxcm9fn2.iterate.app/terminal?command=tail+-n+200+-f+%2Fvar%2Flog%2Fpidnap%2Fprocess%2Fdaemon-frontend.log&autorun=true",
    );
    expect(url).not.toContain("//terminal");
  });

  it("joins nested base paths and relative paths", () => {
    const url = buildProjectIngressLink({
      baseUrl: "https://host.example/root/sub/",
      path: "terminal",
    });

    expect(url).toBe("https://host.example/root/sub/terminal");
  });
});
