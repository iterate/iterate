// CF DNS + route provisioning for projects.

interface Env {
  CF_API_TOKEN: string;
  CF_ZONE_ID: string;
  CF_WORKER_NAME: string;
}

export async function cfAPI(env: Env, method: string, path: string, body?: object): Promise<any> {
  const resp = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return resp.json() as any;
}

export async function provisionProject(env: Env, slug: string) {
  const zoneId = env.CF_ZONE_ID;
  const results = { dns: [] as string[], routes: [] as string[], mx: [] as string[] };
  for (const name of [`*.${slug}.iterate-dev-jonas.app`, `${slug}.iterate-dev-jonas.app`]) {
    const r = await cfAPI(env, "POST", `/zones/${zoneId}/dns_records`, {
      type: "AAAA",
      name,
      content: "100::",
      proxied: true,
    });
    results.dns.push(r.success ? `${name} ok` : `${name} ${r.errors?.[0]?.message}`);
  }
  for (const { content, priority } of [
    { content: "route1.mx.cloudflare.net", priority: 99 },
    { content: "route2.mx.cloudflare.net", priority: 69 },
    { content: "route3.mx.cloudflare.net", priority: 93 },
  ]) {
    const r = await cfAPI(env, "POST", `/zones/${zoneId}/dns_records`, {
      type: "MX",
      name: `${slug}.iterate-dev-jonas.app`,
      content,
      priority,
    });
    results.mx.push(r.success ? `${content} ok` : `${content} ${r.errors?.[0]?.message}`);
  }
  for (const pattern of [`*.${slug}.iterate-dev-jonas.app/*`, `${slug}.iterate-dev-jonas.app/*`]) {
    const r = await cfAPI(env, "POST", `/zones/${zoneId}/workers/routes`, {
      pattern,
      script: env.CF_WORKER_NAME,
    });
    results.routes.push(r.success ? `${pattern} ok` : `${pattern} ${r.errors?.[0]?.message}`);
  }
  return results;
}

export async function deprovisionProject(env: Env, slug: string) {
  const zoneId = env.CF_ZONE_ID;
  for (const name of [`*.${slug}.iterate-dev-jonas.app`, `${slug}.iterate-dev-jonas.app`]) {
    const list = await cfAPI(
      env,
      "GET",
      `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
    );
    for (const rec of list.result ?? [])
      await cfAPI(env, "DELETE", `/zones/${zoneId}/dns_records/${rec.id}`);
  }
  const routes = await cfAPI(env, "GET", `/zones/${zoneId}/workers/routes`);
  for (const route of routes.result ?? []) {
    if (route.pattern.includes(`${slug}.iterate-dev-jonas.app`))
      await cfAPI(env, "DELETE", `/zones/${zoneId}/workers/routes/${route.id}`);
  }
}
