import { envs } from "../../envs.ts";
import { PreviewTestRuns } from "../../apps/os/src/domains/preview-test-runs.ts";
import { resolveEnvContext } from "./env-context.ts";
import { fetchCloudflareWith429Retry } from "./cloudflare-429-retry.ts";

/** The CLI and preview orchestrator use the same per-slot KV control records. */
export async function previewTestRunsForEnvironment(environment: string) {
  if (!/^preview_\d+$/.test(environment)) {
    throw new Error("Test-run retirement is only available for explicit preview_N environments.");
  }
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: environment });
  const path = `/storage/kv/namespaces/${ctx.env.resources.projectDirectoryKvId}/values/`;
  return new PreviewTestRuns({
    get: async (key) => {
      // KV reads return the raw value, unlike the JSON envelope ctx.cf handles.
      const url = `https://api.cloudflare.com/client/v4/accounts/${ctx.env.cloudflareAccountId}${path}${encodeURIComponent(key)}`;
      const response = await fetchCloudflareWith429Retry("read preview test-run record", () =>
        fetch(url, { headers: { authorization: `Bearer ${ctx.secrets.CLOUDFLARE_API_TOKEN}` } }),
      );
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(`Reading preview test-run record failed: HTTP ${response.status}`);
      return response.text();
    },
    put: (key, value) =>
      ctx.cf(`${path}${encodeURIComponent(key)}`, { method: "PUT", body: value }),
  });
}
