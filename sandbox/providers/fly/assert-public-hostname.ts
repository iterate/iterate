import { randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { FlyProvider } from "./provider.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeExternalId(): string {
  const suffix = randomUUID().slice(0, 8);
  return `dev-fly-assert-${suffix}`;
}

function isRetriableCreateError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return (
    message.includes("(503)") ||
    message.includes("(504)") ||
    message.includes("deadline_exceeded") ||
    message.includes("non-200 status code: 504")
  );
}

async function waitForDns(params: {
  host: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<{ ms: number; address: string }> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const resolved = await dnsLookup(params.host);
      return { ms: Date.now() - startedAt, address: resolved.address };
    } catch (error) {
      lastError = error;
      await sleep(params.pollMs);
    }
  }

  throw new Error(`timed out waiting for DNS resolution of ${params.host}`, { cause: lastError });
}

async function waitForHttpReachable(params: {
  url: string;
  timeoutMs: number;
  pollMs: number;
}): Promise<{ ms: number; status: number }> {
  const startedAt = Date.now();
  let lastError: unknown;
  let lastStatus: number | null = null;

  while (Date.now() - startedAt < params.timeoutMs) {
    try {
      const response = await fetch(params.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      lastStatus = response.status;
      // Any HTTP response status proves the public hostname is reachable.
      if (response.status > 0) {
        return { ms: Date.now() - startedAt, status: response.status };
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(params.pollMs);
  }

  throw new Error(
    `timed out waiting for HTTP reachability from ${params.url}; lastStatus=${String(lastStatus)}`,
    {
      cause: lastError,
    },
  );
}

async function main(): Promise<void> {
  const image = process.env.FLY_ASSERT_IMAGE ?? process.env.FLY_DEFAULT_IMAGE;
  if (!image) {
    throw new Error("FLY_ASSERT_IMAGE or FLY_DEFAULT_IMAGE is required");
  }

  const timeoutMs = Number(process.env.FLY_ASSERT_TIMEOUT_MS ?? 240_000);
  const pollMs = Number(process.env.FLY_ASSERT_POLL_MS ?? 2_000);

  const provider = new FlyProvider(process.env as Record<string, string | undefined>);
  const externalId = process.env.FLY_ASSERT_EXTERNAL_ID ?? makeExternalId();
  const baseDomain = process.env.FLY_BASE_DOMAIN ?? "fly.dev";
  const publicBaseHost = `${externalId}.${baseDomain}`;

  let sandbox: Awaited<ReturnType<FlyProvider["create"]>> | null = null;
  const startedAt = Date.now();
  try {
    const maxCreateAttempts = 3;
    for (let attempt = 1; attempt <= maxCreateAttempts; attempt += 1) {
      try {
        sandbox = await provider.create({
          externalId,
          name: externalId,
          envVars: {
            ITERATE_PUBLIC_BASE_HOST: publicBaseHost,
            ITERATE_PUBLIC_BASE_HOST_TYPE: "subdomain",
          },
          providerSnapshotId: image,
        });
        break;
      } catch (error) {
        if (attempt >= maxCreateAttempts || !isRetriableCreateError(error)) {
          throw error;
        }
        await sleep(1_500 * attempt);
      }
    }

    if (!sandbox) {
      throw new Error("Fly provider create returned no sandbox");
    }

    const appHost = `${sandbox.providerId}.${baseDomain}`;
    const healthUrl = `https://${appHost}/healthz`;

    const dns = await waitForDns({
      host: appHost,
      timeoutMs,
      pollMs,
    });

    const http = await waitForHttpReachable({
      url: healthUrl,
      timeoutMs,
      pollMs,
    });

    console.log(`assertion=passed`);
    console.log(`app=${sandbox.providerId}`);
    console.log(`host=${appHost}`);
    console.log(`dns_ms=${String(dns.ms)} address=${dns.address}`);
    console.log(`http_ms=${String(http.ms)} status=${String(http.status)} url=${healthUrl}`);
    console.log(`total_ms=${String(Date.now() - startedAt)}`);
  } finally {
    if (sandbox) {
      await sandbox.delete().catch(() => {});
    }
  }
}

await main();
