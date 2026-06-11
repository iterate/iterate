// itx.secrets — the journaled-Secret surface for project code and agents.
//
// Deliberately reveal-free: project code can SET secrets (enter the Waitrose
// password, declare how the access token derives from it), inspect
// material-free state, and ask a secret's DO to fetch-with-substitution — but
// the only way material flows into a request from here is inside the Secret
// DO or the terminal egress pipe. Userspace integrations are built from
// exactly these verbs plus bare fetch() with getSecret({ key }) placeholders.

import { WorkerEntrypoint } from "cloudflare:workers";
import { replayPathCall, type PathCall } from "~/itx/path-proxy.ts";
import {
  setJournaledSecret,
  type SetJournaledSecretInput,
} from "~/domains/secrets/secret-streams.ts";
import {
  getSecretDurableObjectName,
  getSecretStub,
} from "~/domains/secrets/durable-objects/secret-durable-object.ts";
import type { SubstitutableRequest } from "~/domains/secrets/secret-substitution.ts";

type SecretsJournalCapabilityProps = {
  projectId?: string;
};

export class SecretsJournalCapability extends WorkerEntrypoint<Env, SecretsJournalCapabilityProps> {
  /** itx path-call surface: itx.secrets.set(...), itx.secrets.describe(...). */
  async call(input: PathCall): Promise<unknown> {
    return await replayPathCall(this, input);
  }

  /** Set (or replace) a Secret: material, a derivation, or both. */
  async set(input: Omit<SetJournaledSecretInput, "projectId" | "source">) {
    const event = await setJournaledSecret({
      ...input,
      projectId: this.projectId(),
      source: { kind: "itx-secrets-capability" },
    });
    return { slug: input.slug, offset: event.offset };
  }

  /** Material-free state (plain config variables include their value). */
  async describe(input: { slug: string }) {
    const stub = getSecretStub({ projectId: this.projectId(), slug: input.slug });
    await stub.initialize({
      name: getSecretDurableObjectName({ projectId: this.projectId(), slug: input.slug }),
    });
    return await stub.describe();
  }

  /** Fetch with `{{secret}}` substituted inside the Secret DO. (Named to
   * avoid WorkerEntrypoint's own fetch(Request) handler slot.) */
  async fetchWithSecret(input: { slug: string; request: SubstitutableRequest }) {
    const stub = getSecretStub({ projectId: this.projectId(), slug: input.slug });
    await stub.initialize({
      name: getSecretDurableObjectName({ projectId: this.projectId(), slug: input.slug }),
    });
    return await stub.fetchWithSecret({
      request: input.request,
      usedBy: `itx:secrets.fetch`,
    });
  }

  private projectId() {
    const projectId = this.ctx.props.projectId;
    if (!projectId) {
      throw new Error("SecretsJournalCapability requires dial-injected projectId props.");
    }
    return projectId;
  }
}
