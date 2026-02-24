export interface ConsulHealthServiceEntry {
  Service?: {
    ID?: string;
    Service?: string;
    Address?: string;
    Port?: number;
  };
}

async function responseDetails(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}

export async function waitForConsulServicePassingBlocking(params: {
  consulBaseUrl: string;
  serviceName: string;
  timeoutMs?: number;
  waitSecondsPerRequest?: number;
}): Promise<{ entries: ConsulHealthServiceEntry[]; lastConsulIndex: string }> {
  const timeoutMs = params.timeoutMs ?? 90_000;
  const waitSecondsPerRequest = params.waitSecondsPerRequest ?? 10;
  const startedAt = Date.now();
  let index = "0";

  while (Date.now() - startedAt < timeoutMs) {
    const waitMsRemaining = timeoutMs - (Date.now() - startedAt);
    const waitSeconds = Math.max(
      1,
      Math.min(waitSecondsPerRequest, Math.floor(waitMsRemaining / 1000)),
    );

    const url = new URL(
      `/v1/health/service/${encodeURIComponent(params.serviceName)}`,
      params.consulBaseUrl,
    );
    url.searchParams.set("passing", "1");
    url.searchParams.set("index", index);
    url.searchParams.set("wait", `${String(waitSeconds)}s`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `consul blocking health query failed for ${params.serviceName}: ${await responseDetails(response)}`,
      );
    }

    const nextIndex = response.headers.get("x-consul-index") ?? index;
    const payload = (await response.json()) as unknown;
    const entries = Array.isArray(payload) ? (payload as ConsulHealthServiceEntry[]) : [];

    if (entries.length > 0) {
      return {
        entries,
        lastConsulIndex: nextIndex,
      };
    }

    index = nextIndex;
  }

  throw new Error(
    `timed out waiting for passing consul service ${params.serviceName} (last index=${index})`,
  );
}
