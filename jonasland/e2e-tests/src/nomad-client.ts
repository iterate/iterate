export async function waitForNomadLeader(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/v1/status/leader`);
  if (!response.ok) return false;
  const text = await response.text();
  return text.trim().length > 2;
}

export async function submitNomadJob(baseUrl: string, hcl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/jobs/parse?canonicalize=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ JobHCL: hcl }),
  });
  if (!response.ok) {
    throw new Error(`Nomad parse failed status=${response.status} body=${await response.text()}`);
  }

  const parsed = (await response.json()) as Record<string, unknown> & { Job?: unknown };
  const job = parsed.Job ?? parsed;

  const register = await fetch(`${baseUrl}/v1/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ Job: job }),
  });

  if (!register.ok) {
    throw new Error(
      `Nomad register failed status=${register.status} body=${await register.text()}`,
    );
  }
}

export async function listAllocations(
  baseUrl: string,
): Promise<Array<{ Name?: string; ClientStatus?: string }>> {
  const response = await fetch(`${baseUrl}/v1/allocations`);
  if (!response.ok) {
    throw new Error(
      `Nomad allocations failed status=${response.status} body=${await response.text()}`,
    );
  }
  return (await response.json()) as Array<{ Name?: string; ClientStatus?: string }>;
}

export async function hasReadyNode(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/v1/nodes`);
  if (!response.ok) return false;
  const nodes = (await response.json()) as Array<{
    Status?: string;
    SchedulingEligibility?: string;
  }>;
  return nodes.some(
    (node) => node.Status === "ready" && (node.SchedulingEligibility ?? "eligible") === "eligible",
  );
}

export async function hasConsulReadyNode(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/v1/nodes`);
  if (!response.ok) return false;
  const nodes = (await response.json()) as Array<{
    ID?: string;
    Status?: string;
    SchedulingEligibility?: string;
  }>;

  const eligibleNodes = nodes.filter(
    (node) => node.Status === "ready" && (node.SchedulingEligibility ?? "eligible") === "eligible",
  );

  for (const node of eligibleNodes) {
    if (!node.ID) continue;
    const detailResponse = await fetch(`${baseUrl}/v1/node/${node.ID}`);
    if (!detailResponse.ok) continue;
    const detail = (await detailResponse.json()) as {
      Attributes?: Record<string, string>;
    };
    if (detail.Attributes?.["consul.version"]) return true;
  }

  return false;
}
