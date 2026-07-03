import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "../../../env.ts";
import { DurableObjectNameCodec } from "../../durable-object-names.ts";
import { PROJECT_REPO_PATH } from "../../repos/utils.ts";
import { normalizeCloudflareSandboxPath } from "./utils.ts";

/** Where the project repo is cloned inside every sandbox container. */
const SANDBOX_PROJECT_REPO_DIR = "/workspace/repo";

/**
 * A project-scoped Cloudflare Sandbox: the `@cloudflare/sandbox` container
 * Durable Object, addressed like every other domain object
 * (`{projectId}.iterate/sandboxes/cloudflare/<name>`). The public surface IS
 * the SDK's — `itx.sandboxes.get(path)` returns this object's bare RPC stub
 * (exec, files, processes, ports, gitCheckout, …) with nothing wrapped on top.
 *
 * The one behavior added over the stock SDK class: on every container start
 * the project's repo is cloned to {@link SANDBOX_PROJECT_REPO_DIR}, so code in
 * the sandbox always finds the project's source checked out. Container
 * filesystems are ephemeral — a restart is a fresh disk — which is why the
 * clone belongs to `onStart` rather than to creation.
 */
export class CloudflareSandboxDurableObject extends Sandbox<Env> {
  readonly #name = parseCloudflareSandboxDurableObjectName(this.ctx.id.name!);

  override async onStart(): Promise<void> {
    await super.onStart();
    await this.#cloneProjectRepo();
  }

  // Runs inside the container-start `blockConcurrencyWhile`, so the first
  // exec/readFile that woke the container waits until the repo is in place.
  // Safe to call SDK methods here: the container is already marked healthy
  // when `onStart` fires, so nothing re-enters startup.
  async #cloneProjectRepo(): Promise<void> {
    // Probe a marker only a completed clone has — a bare directory check
    // would treat the debris of an interrupted checkout as done and leave
    // the sandbox without the repo until the container is replaced.
    const existing = await this.exists(`${SANDBOX_PROJECT_REPO_DIR}/.git/HEAD`);
    if (existing.exists) return;
    await this.exec(`rm -rf ${SANDBOX_PROJECT_REPO_DIR}`);

    const repo = this.env.REPO.getByName(
      DurableObjectNameCodec.stringify({
        projectId: this.#name.projectId,
        path: PROJECT_REPO_PATH,
      }),
    );
    const access = await repo.gitAccess();
    // Same credential shape the Repo Durable Object uses for its own clones
    // (username "x", artifact write token as password). Embedding them in the
    // remote keeps `git pull`/`git push` working inside the sandbox.
    const remote = new URL(access.remote);
    remote.username = "x";
    remote.password = access.token;

    const result = await this.gitCheckout(remote.toString(), {
      branch: access.defaultBranch,
      targetDir: SANDBOX_PROJECT_REPO_DIR,
    });
    if (!result.success) {
      throw new Error(
        `cloning the project repo into ${SANDBOX_PROJECT_REPO_DIR} failed (exit ${result.exitCode})`,
      );
    }
  }
}

function parseCloudflareSandboxDurableObjectName(name: string) {
  const parsed = DurableObjectNameCodec.parse(name);
  normalizeCloudflareSandboxPath(parsed.path);
  return parsed;
}
