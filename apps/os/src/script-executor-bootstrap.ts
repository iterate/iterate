import { WorkerEntrypoint } from "cloudflare:workers";

/**
 * Temporary script-executor identity used only while an OS Worker that was
 * parked (or does not exist yet) is restoring its Durable Object exports.
 *
 * The primary OS upload requires its SCRIPT_EXECUTOR service target to exist,
 * while the real executor cannot bind OS-owned Durable Object classes until
 * that upload has landed. The deploy replaces this entrypoint with the real
 * executor before smoke tests begin. A call during an incomplete deployment
 * fails explicitly instead of running with partial authority.
 */
export default class ScriptExecutorBootstrapEntrypoint extends WorkerEntrypoint {
  override fetch(): Response {
    return new Response("Script executor deployment is not finalized.", { status: 503 });
  }

  run(): never {
    throw new Error("Script executor deployment is not finalized");
  }
}
