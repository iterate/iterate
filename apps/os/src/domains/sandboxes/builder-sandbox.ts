import { itxEnv as env } from "../../env.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { SandboxInstanceType } from "./instance-types.ts";
import { SandboxProcessorContract } from "./sandbox-processor-contract.ts";
import { sandboxCreateClaimKey, sandboxPathFor } from "./utils.ts";

/**
 * The per-project builder sandbox: an ORDINARY project sandbox (catalogued,
 * listable, exec-able by project users like any pet — that debuggability is
 * the point) that the platform gets-or-creates on demand to run dynamic
 * worker builds. `basic` (1 GiB) because npm plus wrangler's bundler do not
 * fit `lite`'s 256 MiB.
 *
 * Being ordinary cuts both ways: a project user can destroy it, and destroyed
 * sandbox names are retired forever (the Durable Object tombstones the name).
 * The platform therefore probes name GENERATIONS — `worker-builder`, then
 * `worker-builder-2`, … — until it finds one that is usable or can be born.
 * Cold builds only (warm loads hit the artifact cache), and the common case
 * resolves on the first probe. A name squatted by a user with a different
 * instance type is skipped the same way — and if the user squatted it as
 * `basic`, builds simply run in their sandbox, which the project trust model
 * is fine with (whoever can see a project can already exec into its builder).
 */
const BUILDER_SANDBOX_BASE_NAME = "worker-builder";
const BUILDER_SANDBOX_INSTANCE_TYPE: SandboxInstanceType = "basic";
const BUILDER_SANDBOX_MAX_GENERATIONS = 16;

export async function getOrCreateBuilderSandbox(
  projectId: string,
): Promise<{ path: string; sandbox: ReturnType<(typeof env.SANDBOX_BASIC)["getByName"]> }> {
  const catalogue = env.STREAM.getByName(
    DurableObjectNameCodec.stringify({ projectId, path: "/sandboxes" }),
  );

  for (let generation = 1; generation <= BUILDER_SANDBOX_MAX_GENERATIONS; generation++) {
    const name =
      generation === 1 ? BUILDER_SANDBOX_BASE_NAME : `${BUILDER_SANDBOX_BASE_NAME}-${generation}`;
    const path = sandboxPathFor(name);
    const identity = { path, projectId };
    const sandbox = env.SANDBOX_BASIC.getByName(
      DurableObjectNameCodec.stringify({ projectId, path }),
    );

    // The same claim-first discipline as itx.sandboxes.create: the catalogue
    // append is idempotency-keyed by path, so the event that comes back IS
    // the authoritative claim — ours if the name was free, the original
    // otherwise (racing platform creators converge on one claim).
    const existingClaim = await catalogue.getEvent({ idempotencyKey: sandboxCreateClaimKey(path) });
    const claim =
      existingClaim ??
      (
        await catalogue.append(
          SandboxProcessorContract.buildEvent({
            type: "events.iterate.com/sandbox/create-requested",
            idempotencyKey: sandboxCreateClaimKey(path),
            payload: { path, instanceType: BUILDER_SANDBOX_INSTANCE_TYPE },
          }),
        )
      )[0];
    if (claim === undefined) {
      throw new Error(`builder sandbox "${path}": the catalogue append returned no event`);
    }
    const claimedType = SandboxInstanceType.parse(
      (claim.payload as { instanceType: string }).instanceType,
    );
    if (claimedType !== BUILDER_SANDBOX_INSTANCE_TYPE) continue;

    // The Durable Object record is the strict authority on live/destroyed/
    // unborn. Only the well-known unusable answers advance to a create or the
    // next generation; anything else (transport weather) must propagate as a
    // retryable build error rather than minting garbage generations.
    try {
      await sandbox.assertCreated(identity);
      return { path, sandbox };
    } catch (error) {
      if (isDestroyedSandboxError(error)) continue;
      if (!isUnbornSandboxError(error)) throw error;
    }

    // Claimed but not (fully) born: a fresh claim, a create that died between
    // the catalogue append and the Durable Object call, or a durable
    // `creationPending` record from an interrupted birth — `create` is the
    // documented recovery for all three (it resumes the idempotent birth
    // batch). A racing sibling's "already exists" is success by another name.
    try {
      await sandbox.create({ instanceType: BUILDER_SANDBOX_INSTANCE_TYPE, path, projectId });
    } catch (error) {
      if (isDestroyedSandboxError(error)) continue;
      const raceWinnerExists = error instanceof Error && error.message.includes("already exists");
      if (!raceWinnerExists) throw error;
    }
    await sandbox.assertCreated(identity);
    return { path, sandbox };
  }

  throw new Error(
    `no usable builder sandbox generation for ${projectId} within ` +
      `${BUILDER_SANDBOX_MAX_GENERATIONS} names — were they all destroyed?`,
  );
}

// The sandbox Durable Object's unusable-state answers cross Workers RPC as
// plain Errors, so the MESSAGE is the only classification channel. These
// phrases are the DO's stable user-facing contract strings
// (cloudflare-sandbox-durable-object.ts #usableRecord / create).
function isDestroyedSandboxError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("cannot be reused");
}

/** Unborn = no record yet ("does not exist"/"never created") or an
 * interrupted birth left a durable creationPending record ("creation did not
 * finish"). Both heal through `create` — see the call site. */
function isUnbornSandboxError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("does not exist") ||
      error.message.includes("never created") ||
      error.message.includes("creation did not finish"))
  );
}
