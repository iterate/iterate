import { z } from "zod";
import { Lifetime, ProjectMetadata } from "@iterate-com/shared/lifetime";

/** Answers only whether background work should stop. The caller owns its
 * alarms/container shutdown. No environment or caller-specific policy here.
 */
export class ProjectLifetime {
  constructor(
    private storage: Pick<DurableObjectStorage["kv"], "get" | "put">,
    private directory: Pick<KVNamespace, "get"> | undefined,
    private projectId: string | null,
  ) {}

  get enabled(): boolean {
    return Boolean(this.directory && this.projectId);
  }

  get expired(): boolean {
    return this.storage.get<boolean>("lifetime:expired") === true;
  }

  async hasExpired(): Promise<boolean> {
    if (this.expired) return true;
    if (!this.projectId) return false;

    let lifetime = this.storage.get<Lifetime>("lifetime:policy");
    if (!lifetime) {
      if (!this.directory) return false;
      const raw = await this.directory.get(`project:${this.projectId}`);
      if (!raw) return false;
      const project = z.object({ metadata: ProjectMetadata.optional() }).parse(JSON.parse(raw));
      lifetime = project.metadata?.lifetime;
      if (!lifetime) return false;
      // Creation metadata is immutable. Remember it across eviction and missing
      // directory records; neither may extend this object's lifetime.
      this.storage.put("lifetime:policy", lifetime);
    }

    const expired =
      lifetime.expiresAt <= Date.now() ||
      (lifetime.group &&
        this.directory &&
        (await this.directory.get(`lifetime:group:${lifetime.group}`)) === "retired");
    if (!expired) return false;
    // A stale group read must never revive work we have already stopped.
    this.storage.put("lifetime:expired", true);
    console.log("project background lifetime expired", { projectId: this.projectId });
    return true;
  }
}
