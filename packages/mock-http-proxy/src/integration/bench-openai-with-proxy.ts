import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { x } from "tinyexec";
import { useMitmProxy, useMockHttpServer } from "../server/mock-http-server-fixture.ts";

const thisDir = dirname(fileURLToPath(import.meta.url));

async function main() {
  await using egress = await useMockHttpServer({ onUnhandledRequest: "bypass" });
  await using mitm = await useMitmProxy({ externalEgressProxyUrl: egress.url });

  const startedAt = Date.now();
  const result = await x(
    "pnpm",
    ["exec", "tsx", join(thisDir, "http-client-scripts", "openai-responses-websockets.ts")],
    {
      throwOnError: true,
      nodeOptions: {
        env: {
          ...process.env,
          ...mitm.envForNode(),
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_REALTIME_TIMEOUT_MS: process.env.OPENAI_REALTIME_TIMEOUT_MS ?? "8000",
        },
        cwd: join(thisDir, "..", ".."),
        stdio: "pipe",
      },
    },
  );

  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(`${result.stdout.trim()}\n`);
  process.stdout.write(JSON.stringify({ elapsedMs }) + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
