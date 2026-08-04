export interface KillableDynamicWorker {
  kill(): Promise<void>;
}

/**
 * Terminates one dynamic Durable Object generation and normalises only its
 * intentional self-abort into success.
 *
 * `ctx.abort("kill requested")` is the desired implementation because it
 * immediately severs the PCM/provider generation and every in-flight RPC.
 * Consequently, the caller asking for that abort observes the abort too: it
 * cannot receive an ordinary return from an object which no longer exists.
 * That exact object-authored reason is therefore an acknowledgement. Every
 * other rejection remains a real delivery/transport failure, because it does
 * not prove the old provider generation stopped.
 */
export async function killDynamicWorkerGeneration(worker: KillableDynamicWorker): Promise<void> {
  try {
    await worker.kill();
  } catch (error) {
    if (error instanceof Error && error.message === "kill requested") return;
    throw error;
  }
}
