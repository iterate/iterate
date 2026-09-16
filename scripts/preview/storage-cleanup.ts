import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { envs, streamsExampleEnvs } from "../../envs.ts";
import { mintForgedAccessToken } from "../auth/forge-token.ts";
import { resolveEnvContext } from "../lib/env-context.ts";
import { getWorkerDoNamespaces } from "../lib/do-reset.ts";
import { fetchCloudflareWith429Retry } from "../lib/cloudflare-429-retry.ts";

/** Clear preview objects without replacing code, namespaces, Auth data or routes. */
export async function resetPreviewStorage(options: { env: string; allowUnsupported: boolean }) {
  if (!/^preview_\d+$/.test(options.env))
    throw new Error("Storage cleanup only supports preview slots");
  const os = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  const streams = await resolveEnvContext({
    envs: streamsExampleEnvs,
    dopplerProject: "streams-example-app",
    env: options.env,
  });
  const targets = [
    {
      worker: os.env.osWorkerName,
      url: os.env.baseUrl,
      token: os.secrets.APP_CONFIG_ADMIN_API_SECRET,
    },
    {
      worker: streams.env.workerName,
      url: streams.env.baseUrl,
      token: await mintForgedAccessToken({
        forgePrivateJwk: streams.secrets.AUTH_FORGE_ES256_PRIVATE_JWK!,
        issuer: `${streams.env.authBaseUrl}/api/auth`,
        audience: streams.env.baseUrl,
        email: "preview-storage-cleanup@iterate.com",
        admin: true,
      }),
    },
  ];
  const prepared: ((typeof targets)[number] & {
    protocol: 1;
    version: string;
    classes: string[];
  })[] = [];
  for (const target of targets) {
    if (!target.token) throw new Error(`No cleanup credential for ${target.worker}`);
    const response = await fetch(new URL("/api/__internal/reset-storage", target.url), {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (options.allowUnsupported && (response.status === 404 || response.status === 503)) {
      console.log(
        `${target.worker}: storage cleanup unavailable (${response.status}); first deployment needs the existing full erase`,
      );
      await response.body?.cancel();
      return { supported: false };
    }
    if (!response.ok)
      throw new Error(
        `${target.worker}: cleanup handshake failed (${response.status}): ${(await response.text()).slice(0, 400)}`,
      );
    const protocol = z
      .object({ protocol: z.literal(1), version: z.string().min(1), classes: z.array(z.string()) })
      .parse(await response.json());
    prepared.push({ ...target, ...protocol });
  }

  const startedAt = new Date().toISOString();
  const directory = resolve("test-results/storage-cleanup", startedAt.replaceAll(":", "-"));
  await mkdir(directory, { recursive: true });
  const objects: {
    worker: string;
    className: string;
    namespaceId: string;
    objectId: string;
    version: string;
  }[] = [];
  for (const target of prepared) {
    const namespaces = await getWorkerDoNamespaces(os, target.worker);
    for (const namespace of namespaces) {
      if (!target.classes.includes(namespace.className))
        throw new Error(`${target.worker}: cannot clean unknown class ${namespace.className}`);
      let cursor = "";
      do {
        const url = `https://api.cloudflare.com/client/v4/accounts/${os.env.cloudflareAccountId}/workers/durable_objects/namespaces/${namespace.namespaceId}/objects?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const response = await fetchCloudflareWith429Retry(`inventory ${namespace.className}`, () =>
          fetch(url, {
            headers: { authorization: `Bearer ${os.secrets.CLOUDFLARE_API_TOKEN}` },
            signal: AbortSignal.timeout(30_000),
          }),
        );
        if (!response.ok)
          throw new Error(
            `Object inventory failed (${response.status}): ${(await response.text()).slice(0, 400)}`,
          );
        const page = z
          .object({
            success: z.literal(true),
            result: z.array(z.object({ id: z.string(), hasStoredData: z.boolean() })),
            result_info: z.object({ cursor: z.string().optional() }).optional(),
          })
          .parse(await response.json());
        objects.push(
          ...page.result
            .filter((object) => object.hasStoredData)
            .map((object) => ({
              worker: target.worker,
              className: namespace.className,
              namespaceId: namespace.namespaceId,
              objectId: object.id,
              version: target.version,
            })),
        );
        cursor = page.result_info?.cursor || "";
      } while (cursor);
    }
  }
  await writeFile(
    resolve(directory, "inventory.json"),
    JSON.stringify({ startedAt, env: options.env, objects }, null, 2),
  );
  console.log(`Storage cleanup: ${objects.length} objects inventoried in ${options.env}`);

  const results: { objectId: string; className: string; reset: boolean; error?: string }[] = [];
  // Stop producers first. Streams go last because container shutdown and domain
  // cleanup may append lifecycle events to them. No new tests may run during this sweep.
  const classOrder = [...new Set(objects.map((object) => object.className))].sort(
    (a, b) => cleanupOrder(a) - cleanupOrder(b),
  );
  for (const className of classOrder) {
    const queue = objects.filter((object) => object.className === className);
    await Promise.all(
      Array.from({ length: 10 }, async () => {
        for (let object = queue.shift(); object; object = queue.shift()) {
          const target = prepared.find((entry) => entry.worker === object.worker)!;
          try {
            const response = await fetch(new URL("/api/__internal/reset-storage", target.url), {
              method: "POST",
              headers: {
                authorization: `Bearer ${target.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(object),
              signal: AbortSignal.timeout(30_000),
            });
            if (!response.ok)
              throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
            z.object({ reset: z.literal(true), objectId: z.literal(object.objectId) }).parse(
              await response.json(),
            );
            results.push({ objectId: object.objectId, className, reset: true });
          } catch (error) {
            results.push({
              objectId: object.objectId,
              className,
              reset: false,
              error: String(error),
            });
          }
        }
      }),
    );
    console.log(
      `Storage cleanup: ${className}: ${results.filter((result) => result.className === className && result.reset).length} reset`,
    );
  }
  const report = {
    env: options.env,
    startedAt,
    finishedAt: new Date().toISOString(),
    objects: results,
  };
  await writeFile(resolve(directory, "results.json"), JSON.stringify(report, null, 2));
  const failures = results.filter((result) => !result.reset);
  if (failures.length)
    throw new Error(
      `${failures.length}/${results.length} resets failed; see ${directory}/results.json. First: ${failures[0]!.error}`,
    );
  for (const target of prepared) {
    const response = await fetch(new URL("/api/__internal/reset-storage", target.url), {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(`${target.worker} not healthy after cleanup (${response.status})`);
    z.object({ version: z.literal(target.version) }).parse(await response.json());
  }
  return { supported: true, ...report };
}

function cleanupOrder(className: string) {
  if (className.startsWith("Sandbox")) return 0;
  if (className === "SchedulerDurableObject") return 1;
  if (className === "StatefulWorkerDurableObject") return 2;
  if (className === "StreamDurableObject") return 4;
  return 3;
}
