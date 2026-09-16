import { Lifetime } from "@iterate-com/shared/lifetime";
import { envs } from "../../envs.ts";
import { resolveEnvContext } from "./env-context.ts";
import { fetchCloudflareWith429Retry } from "./cloudflare-429-retry.ts";

/** CI orchestration only. Runtime objects see ordinary project metadata and
 * group retirement; they never read these ci:* bookkeeping records.
 */
export class PreviewLifetimes {
  private store: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string): Promise<unknown>;
  };

  constructor(store: PreviewLifetimes["store"]) {
    this.store = store;
  }

  /** The caller holds the slot lifecycle lock. Expiry also covers killed CI. */
  async begin(input: { group: string; expiresAt: number }): Promise<void> {
    const lifetime = Lifetime.required().parse(input);
    if (lifetime.expiresAt <= Date.now()) throw new Error("Cannot begin an expired lifetime.");
    if ((await this.store.get(`lifetime:group:${lifetime.group}`)) === "retired") {
      throw new Error("Cannot restart a retired group; use a new attempt.");
    }
    const existing = await this.store.get(`ci:lifetime:${lifetime.group}`);
    if (existing && Lifetime.parse(JSON.parse(existing)).expiresAt !== lifetime.expiresAt) {
      throw new Error("An attempt's deadline is immutable.");
    }
    const predecessor = await this.store.get("ci:current-lifetime-group");
    if (predecessor && predecessor !== lifetime.group) await this.retire(predecessor);
    if (!existing) await this.store.put(`ci:lifetime:${lifetime.group}`, JSON.stringify(lifetime));
    await this.store.put("ci:current-lifetime-group", lifetime.group);

    // This app uses arbitrary project namespaces, not Auth project records.
    const id = `ephemeral-${lifetime.group.replaceAll("/", "-")}`;
    await this.store.put(
      `project:${id}`,
      JSON.stringify({
        id,
        slug: id,
        name: id,
        organizationId: null,
        metadata: { lifetime },
      }),
    );
  }

  /** Every writer puts the same value. An old finalizer cannot unretire anything. */
  async retire(group: string): Promise<void> {
    group = Lifetime.shape.group.unwrap().parse(group);
    await this.store.put(`lifetime:group:${group}`, "retired");
  }

  async canReuseEnvironment(holder: string): Promise<boolean> {
    return (await this.store.get("ci:lifetime-protocol")) === `v1:${holder}`;
  }

  async markEnvironmentReusable(holder: string): Promise<void> {
    await this.store.put("ci:lifetime-protocol", `v1:${holder}`);
  }
}

export async function previewLifetimesForEnvironment(environment: string) {
  if (!/^preview_\d+$/.test(environment))
    throw new Error("Preview orchestration requires an explicit preview_N environment.");
  const ctx = await resolveEnvContext({ envs, dopplerProject: "os", env: environment });
  const path = `/storage/kv/namespaces/${ctx.env.resources.projectDirectoryKvId}/values/`;
  return new PreviewLifetimes({
    get: async (key) => {
      const url = `https://api.cloudflare.com/client/v4/accounts/${ctx.env.cloudflareAccountId}${path}${encodeURIComponent(key)}`;
      const response = await fetchCloudflareWith429Retry("read preview lifetime", () =>
        fetch(url, { headers: { authorization: `Bearer ${ctx.secrets.CLOUDFLARE_API_TOKEN}` } }),
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Reading preview lifetime failed: HTTP ${response.status}`);
      return response.text();
    },
    put: (key, value) =>
      ctx.cf(`${path}${encodeURIComponent(key)}`, { method: "PUT", body: value }),
  });
}
