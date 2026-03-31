import type { HarWithExtensions } from "@iterate-com/mock-http-proxy";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";

export const replayFixtureOpenAiKey =
  "sk-proj-XVqC7k9h6rEOfbSs8XP9qzlOELpRTFmbdEkkwejcF---sanitised-secret-acf2c7b4";

export async function runPiConversation(params: { deployment: Deployment; sessionDir: string }) {
  const baseArgs = [
    "--provider",
    "openai",
    "--model",
    "gpt-4o-mini",
    "--thinking",
    "off",
    "--no-tools",
    "--session-dir",
    params.sessionDir,
  ];
  const turn1 = await params.deployment.exec([
    "pi",
    ...baseArgs,
    "-p",
    "Return only JavaScript code for a function named add that adds two numbers.",
  ]);
  const turn2 = await params.deployment.exec([
    "pi",
    ...baseArgs,
    "--continue",
    "-p",
    "Revise that to TypeScript with explicit number types. Return only code.",
  ]);
  const turn3 = await params.deployment.exec([
    "pi",
    ...baseArgs,
    "--continue",
    "-p",
    "Now add a minimal Vitest test below it. Return only code.",
  ]);
  return { turn1, turn2, turn3 };
}

export async function configureFrpEgressProxy(params: {
  deployment: Deployment;
  egressProxyURL: string;
}) {
  await params.deployment.setEnvVars({
    ITERATE_EGRESS_PROXY: params.egressProxyURL,
  });
  await params.deployment.pidnap.processes.restart({
    target: "caddy",
    force: true,
  });
  await params.deployment.waitUntilHealthy({
    timeoutMs: 30_000,
  });
}

export async function waitUntilFrpTunnelIsActive(params: { deployment: Deployment }) {
  await params.deployment.shellWithRetry({
    cmd: "curl -sS --max-time 2 -o /dev/null -w '%{http_code}' http://127.0.0.1:27180/__iterate/health",
    timeoutMs: 30_000,
    retryIf: (result) => result.output.trim() === "000" || result.exitCode !== 0,
  });

  await params.deployment.shellWithRetry({
    cmd: String.raw`curl -k -sSI https://example.com/ | tr -d '\r' | grep -qi '^x-iterate-egress-mode: external-proxy$'`,
    timeoutMs: 30_000,
    retryIf: (result) => result.exitCode !== 0,
  });
}

export function harRequestUrls(har: HarWithExtensions): string[] {
  return (har.log?.entries ?? [])
    .map((entry) => entry.request?.url)
    .filter((value): value is string => Boolean(value));
}

export function harLooksLikeAiTraffic(urls: string[]) {
  return urls.some((url) => {
    const host = new URL(url).host;
    return (
      host.includes("openai.com") ||
      host.includes("anthropic.com") ||
      host.includes("googleapis.com") ||
      host.includes("generativelanguage.googleapis.com")
    );
  });
}
