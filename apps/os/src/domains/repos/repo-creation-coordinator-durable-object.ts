import { DurableObject } from "cloudflare:workers";
import { workerVersion, type Env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";

const QUEUED_CREATION_STORAGE_KEY = "repo-creation:queued";
const CREATION_HANDOFF_DELAY_MS = 1_000;
const CREATION_RETRY_DELAY_MS = 60_000;

/**
 * One coordinator per repo creation saga.
 *
 * RepoProcessor is hosted through a callback retained by the source Stream
 * Durable Object. Cloudflare does not service a Repo Durable Object alarm
 * while that retained RPC event remains open, so creation cannot safely hand
 * work to an alarm on the Repo object itself. This separate object persists
 * the handoff, owns the alarm, and calls the Repo only after the processor
 * batch has committed its create request.
 */
export class RepoCreationCoordinatorDurableObject extends DurableObject<Env> {
  readonly #name = DurableObjectNameCodec.parse(this.ctx.id.name!, { allowNullProjectId: true });

  /** Report this incarnation's code version for the deployment rollout gate. */
  deploymentVersion(): string {
    return workerVersion(this.env);
  }

  /** Persist a first handoff without pulling an existing retry alarm forward. */
  async enqueue(): Promise<void> {
    if (this.ctx.storage.kv.get<boolean>(QUEUED_CREATION_STORAGE_KEY)) return;
    this.ctx.storage.kv.put(QUEUED_CREATION_STORAGE_KEY, true);
    await this.ctx.storage.setAlarm(Date.now() + CREATION_HANDOFF_DELAY_MS);
  }

  /** Own the attempt until the Repo journals a terminal fact. */
  async alarm(): Promise<void> {
    if (!this.ctx.storage.kv.get<boolean>(QUEUED_CREATION_STORAGE_KEY)) return;

    try {
      await this.env.REPO.getByName(
        DurableObjectNameCodec.stringify(this.#name, { allowNullProjectId: true }),
      ).continueCreation();
    } catch (error) {
      // Native alarm retries are bounded. Retain an explicit coarse wake-up
      // across longer vendor outages, while rethrowing keeps this attempt in
      // Cloudflare's error signal instead of silently normalizing it.
      await this.ctx.storage.setAlarm(Date.now() + CREATION_RETRY_DELAY_MS);
      throw error;
    }

    this.ctx.storage.kv.delete(QUEUED_CREATION_STORAGE_KEY);
  }
}
