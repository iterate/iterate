import { spawn } from "node:child_process";

/**
 * Start cloudflared as a child process, connecting a Cloudflare Tunnel to the
 * local dev server. Call this AFTER `app.finalize()` — it's a long-running
 * process, not an alchemy resource.
 *
 * Waits for the local vite dev server to respond before starting cloudflared,
 * so tunnel traffic doesn't hit a cold server.
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/configure-tunnels/local-management/as-a-service/
 */
export async function startCloudflared(options: {
  tunnelToken: string;
  vitePort: number;
  displayUrl: string;
}) {
  // Wait for vite to be ready before connecting the tunnel
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://localhost:${options.vitePort}`, { signal: AbortSignal.timeout(1_000) });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  console.log(`Starting cloudflared tunnel: ${options.displayUrl}`);

  // --protocol http2: avoids QUIC issues on some networks
  // --no-autoupdate: we manage cloudflared version via brew
  const cloudflared = spawn(
    "cloudflared",
    [
      "tunnel",
      "--loglevel",
      "warn",
      "--protocol",
      "http2",
      "--no-autoupdate",
      "run",
      "--token",
      options.tunnelToken,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  cloudflared.on("error", (err) => {
    console.error("Failed to start cloudflared:", err.message);
    console.error("Install with: brew install cloudflared");
  });
  cloudflared.on("spawn", () => console.log(`Cloudflared started (pid ${cloudflared.pid})`));
  cloudflared.on("exit", (code, signal) => {
    if (code !== 0 && code !== null) console.error(`Cloudflared exited with code ${code}`);
    else if (signal) console.log(`Cloudflared killed by signal ${signal}`);
  });

  process.on("exit", () => cloudflared.kill());
  process.on("SIGINT", () => {
    cloudflared.kill();
    process.exit(0);
  });
}
