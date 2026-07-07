// Zero-onboarding provisioning (tasks/email-agent-zero-onboarding.md): the
// email sender directory lookup + the auto-provisioning chain the bot@ lane
// of the email ingress runs for brand-new verified senders. Ported from PR
// #1707 onto the #1711 inbound-email foundation.

import {
  isReservedPlatformSlug,
  resolveUniqueSlug,
  slugifyWithSuffix,
} from "@iterate-com/shared/slug";
import { itxAuthFromPrincipal } from "../../auth.ts";
import { createUserPrincipal } from "../../auth/principal.ts";
import { createAuthWorkerServiceClient } from "../../auth/auth-worker-service.ts";
import type { AppConfig } from "../../config.ts";
import { itxEnv } from "../../env.ts";
import { readProjectById } from "../../project-directory.ts";
import { ProjectCollectionRpcTarget } from "../../rpc-targets.ts";
import {
  integrationStreamStub,
  streamEventsNewestFirst,
} from "../integrations/integration-streams.ts";
import {
  EMAIL_SENDER_CLAIMED_EVENT_TYPE,
  EMAIL_SENDER_DIRECTORY_STREAM_PATH,
  foldEmailSenderDirectory,
  normalizeEmailAddress,
} from "./utils.ts";

/**
 * The email sender directory lookup + zero-onboarding provisioning chain.
 * Returns null when the sender is unclaimed and provisioning is not allowed
 * (the env's zeroOnboardingEnabled gate is off).
 *
 * Race safety without new Durable Object surface: the claim event is
 * idempotency-keyed on the normalized address and the directory fold is
 * first-claim-wins, so concurrent first emails from one new sender converge
 * on a single project — a losing provisioner reads the directory back,
 * adopts the winner, and logs its own orphaned org/project. Partial failures
 * before the claim append simply re-run the chain on the next email
 * (upsertVerifiedEmail is get-or-create); an orphaned auth org is the
 * accepted worst case (see the task file).
 */
export async function resolveSenderProject(input: {
  config: AppConfig;
  ctx: ExecutionContext;
  address: string;
  name: string | undefined;
  allowProvision: boolean;
}): Promise<{ projectId: string; slug: string; provisioned: boolean } | null> {
  const address = normalizeEmailAddress(input.address);
  const authClient = createAuthWorkerServiceClient({ config: input.config });

  const claimed = (await readSenderDirectory()).get(address);
  if (claimed !== undefined) {
    return { projectId: claimed, slug: await slugOf(claimed), provisioned: false };
  }
  if (!input.allowProvision) return null;

  const localPart = address.slice(0, address.lastIndexOf("@"));
  const displayName = input.name?.trim() || localPart;

  const user = await authClient.internal.user.upsertVerifiedEmail({
    email: address,
    name: displayName,
  });
  const organization = await authClient.internal.organization.createForUser({
    userId: user.id,
    name: displayName,
    slug: localPart,
  });

  // Project slugs are globally unique in auth (cross-org conflicts are hard
  // errors, not auto-suffixed like org slugs), so probe first and keep one
  // suffixed retry for the probe-to-create race.
  const projectSlug = await resolveUniqueSlug({
    name: localPart,
    isTaken: async (candidate) =>
      isReservedPlatformSlug(candidate) ||
      (await authClient.internal.project.bySlug({ projectSlug: candidate })) !== null,
  });

  const auth = itxAuthFromPrincipal(
    input.config,
    createUserPrincipal({
      userId: user.id,
      // The principal's email seeds the new project's own sender allowlist
      // (ProjectCollectionRpcTarget.create appends email/sender-allowed for
      // the creator), which is what lets this sender's thread replies to
      // `<slug>+t<id>@` pass the project-inbox lane later.
      email: address,
      organizations: [
        { id: organization.id, name: organization.name, slug: organization.slug, role: "owner" },
      ],
      projects: [],
    }),
  );

  const createProject = async (slug: string) => {
    // ProjectCollectionRpcTarget.create runs the full bootstrap saga (auth
    // registration, directory priming, processor subscriptions, repo seed) —
    // the same path the dashboard uses — and adopts the canonical id/slug into
    // its args. waitUntilCreated so the email router subscription exists
    // before the first email/received lands.
    const args = { organizationSlug: organization.slug, slug } as {
      organizationSlug?: string;
      projectId?: string;
      slug: string;
      waitUntilCreated?: boolean;
    };
    await new ProjectCollectionRpcTarget({
      auth,
      config: input.config,
      ctx: input.ctx,
    }).create(args);
    return { projectId: args.projectId!, slug: args.slug };
  };

  let created: { projectId: string; slug: string };
  try {
    created = await createProject(projectSlug);
  } catch (error) {
    if (!/conflict|already taken|already exists/i.test(String(error))) throw error;
    created = await createProject(slugifyWithSuffix(localPart));
  }

  await integrationStreamStub(null, EMAIL_SENDER_DIRECTORY_STREAM_PATH).append({
    type: EMAIL_SENDER_CLAIMED_EVENT_TYPE,
    idempotencyKey: `email-sender-claim:${address}`,
    payload: {
      address,
      projectId: created.projectId,
      userId: user.id,
      organizationSlug: organization.slug,
    },
  });

  const winner = (await readSenderDirectory()).get(address);
  if (winner !== undefined && winner !== created.projectId) {
    console.warn(
      `[email-zero-onboarding] lost sender-claim race for ${address}: provisioned ${created.projectId}, adopting ${winner} (orphaned org ${organization.slug})`,
    );
    return { projectId: winner, slug: await slugOf(winner), provisioned: false };
  }
  return { ...created, provisioned: true };
}

/**
 * The folded sender directory. The stream is small (one claim per unique
 * sender), so collect it fully and fold oldest-first — that is the order
 * foldEmailSenderDirectory's first-claim-wins semantics are defined over.
 */
async function readSenderDirectory(): Promise<Map<string, string>> {
  const newestFirst = [];
  for await (const event of streamEventsNewestFirst(null, EMAIL_SENDER_DIRECTORY_STREAM_PATH)) {
    newestFirst.push(event);
  }
  return foldEmailSenderDirectory(newestFirst.reverse());
}

/**
 * The ingress needs the claimed project's SLUG (the received event's
 * recipient identity and the address replies leave from), and the sender
 * directory stores only ids. The project directory (the same source
 * EmailRpcTarget's sender identity uses) resolves it.
 */
async function slugOf(projectId: string): Promise<string> {
  const record = await readProjectById(itxEnv.PROJECT_DIRECTORY, projectId);
  if (!record) throw new Error(`email sender directory names unknown project ${projectId}`);
  return record.slug;
}
