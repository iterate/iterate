// RepoDO — thin wrapper around Cloudflare Artifacts binding.
// One per project, keyed by slug. Owns artifact token creation, forking, deletion.

import { DurableObject } from "cloudflare:workers";

interface Env {
  ARTIFACTS: any;
}

export class RepoDO extends DurableObject<Env> {
  #metaReady = false;

  #ensureMetaTable() {
    if (this.#metaReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    this.#metaReady = true;
  }

  #getMeta(key: string): string | null {
    this.#ensureMetaTable();
    const rows = this.ctx.storage.sql.exec("SELECT value FROM _meta WHERE key = ?", key).toArray();
    return rows.length > 0 ? (rows[0].value as string) : null;
  }

  #setMeta(key: string, value: string) {
    this.#ensureMetaTable();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
      key,
      value,
    );
  }

  get repoName(): string | null {
    return this.#getMeta("repo_name");
  }

  init(repoName: string) {
    this.#setMeta("repo_name", repoName);
  }

  async getToken(permission: "read" | "write", ttl = 3600): Promise<string> {
    const name = this.repoName;
    if (!name) throw new Error("RepoDO not initialized (no repo_name)");
    const repo = await this.env.ARTIFACTS.get(name);
    const result = await repo.createToken(permission, ttl);
    return result.plaintext ?? result.token ?? String(result);
  }

  async getRemote(): Promise<string> {
    const name = this.repoName;
    if (!name) throw new Error("RepoDO not initialized (no repo_name)");
    const repo = await this.env.ARTIFACTS.get(name);
    return repo.remote;
  }

  async forkFromBase(slug: string): Promise<{ name: string; remote: string }> {
    const baseRepo = await this.env.ARTIFACTS.get("base-template");
    try {
      const forked = await baseRepo.fork(`project-${slug}`);
      this.#setMeta("repo_name", forked.name);
      return { name: forked.name, remote: forked.remote };
    } catch (e: any) {
      console.error("[RepoDO] fork failed:", e.message);
      const repo = await this.env.ARTIFACTS.create(`project-${slug}`);
      this.#setMeta("repo_name", repo.name);
      return { name: repo.name, remote: repo.remote };
    }
  }

  async deleteRepo(): Promise<void> {
    const name = this.repoName;
    if (!name) return;
    try {
      await this.env.ARTIFACTS.delete(name);
    } catch (e: any) {
      console.error(`[RepoDO] delete failed: ${e.message}`);
    }
  }
}
