export async function consulIsHealthy(baseUrl: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/v1/status/leader`);
  if (!response.ok) return false;
  const text = await response.text();
  return text.trim().length > 2;
}

export async function consulHasPassingService(
  baseUrl: string,
  serviceName: string,
): Promise<boolean> {
  const response = await fetch(
    `${baseUrl}/v1/health/service/${encodeURIComponent(serviceName)}?passing=true`,
  );
  if (!response.ok) return false;
  const services = (await response.json()) as unknown[];
  return services.length > 0;
}
