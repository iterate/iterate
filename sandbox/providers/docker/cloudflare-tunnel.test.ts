import { Resolver } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { describe } from "vitest";
import { RUN_SANDBOX_TESTS, TEST_CONFIG, test } from "../../test/helpers.ts";

const RUN_DOCKER_CLOUDFLARE_TUNNEL_TESTS =
  RUN_SANDBOX_TESTS &&
  TEST_CONFIG.provider === "docker" &&
  process.env.RUN_DOCKER_CLOUDFLARE_TUNNEL_TESTS === "true";

describe.runIf(RUN_DOCKER_CLOUDFLARE_TUNNEL_TESTS).concurrent("Docker Cloudflare Tunnel", () => {
  test.scoped({
    envOverrides: {
      DOCKER_SERVICE_TRANSPORT: "cloudflare-tunnel",
      DOCKER_CLOUDFLARE_TUNNEL_PORTS: "3000",
    },
    sandboxOptions: {
      id: "docker-cloudflare-tunnel-test",
      name: "Docker Cloudflare Tunnel Test",
      envVars: {},
      entrypointArguments: ["sleep", "infinity"],
    },
  });

  test("exposes preview URL via trycloudflare", async ({ sandbox, expect }) => {
    await sandbox.exec(["sh", "-c", "echo tunnel-ok > /tmp/tunnel-ok.txt"]);
    await sandbox.exec([
      "sh",
      "-c",
      "python3 -m http.server 3000 --bind 0.0.0.0 --directory /tmp >/tmp/tunnel-server.log 2>&1 &",
    ]);

    const previewUrl = await sandbox.getPreviewUrl({ port: 3000 });
    expect(previewUrl).toContain(".trycloudflare.com");

    await expect
      .poll(async () => fetchTunnelText(previewUrl, "/tunnel-ok.txt"), {
        timeout: 90_000,
        interval: 1_000,
      })
      .toContain("tunnel-ok");
  }, 120_000);
});

const CLOUDFLARE_DNS_SERVERS = ["1.1.1.1", "1.0.0.1"] as const;

async function fetchTunnelText(baseUrl: string, pathname: string): Promise<string> {
  const url = new URL(pathname, baseUrl);

  const directResponse = await fetch(url).catch(() => null);
  if (directResponse?.ok) {
    return await directResponse.text();
  }

  if (!url.hostname.endsWith(".trycloudflare.com")) {
    return "";
  }

  const resolver = new Resolver();
  resolver.setServers([...CLOUDFLARE_DNS_SERVERS]);
  const [address] = await resolver.resolve4(url.hostname).catch(() => []);
  if (!address) {
    return "";
  }

  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        lookup: (_hostname, options, callback) => {
          if (options?.all) {
            callback(null, [{ address, family: 4 }]);
            return;
          }
          callback(null, address, 4);
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.resume();
          resolve("");
          return;
        }

        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve(text));
      },
    );

    req.setTimeout(10_000, () => req.destroy(new Error("timeout")));
    req.on("error", () => resolve(""));
    req.end();
  });
}
