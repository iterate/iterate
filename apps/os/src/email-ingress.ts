// Email ingress wiring (tasks/email-agent-zero-onboarding.md): binds the pure
// inbound-email core (domains/email/inbound.ts) to real worker resources —
// the sender directory stream, the auth worker's provisioning endpoints, the
// project directory, and the /integrations/email streams.
//
// Two thin adapters share one handleInboundEmail:
//   - the worker's `email()` entrypoint (real Cloudflare Email Routing
//     deliveries — attach a catch-all route on the deployment's email domain);
//   - handleEmailInjectApiRequest, the admin-secret-gated
//     POST /api/integrations/email/inject lane that e2e tests and local dev
//     use (there is no way to trigger `email()` without real MX).
// Everything past the adapter — parsing, sender verification, provisioning,
// routing — is identical and e2e-covered; only Cloudflare's own SPF/DKIM
// computation is out of test reach (it is Cloudflare's contract, not ours).

import { z } from "zod";
import {
  isReservedPlatformSlug,
  resolveUniqueSlug,
  slugifyWithSuffix,
} from "@iterate-com/shared/slug";
import { provisionedUserAuthContext } from "./auth.ts";
import { authenticateAdminApiSecret } from "./auth/admin.ts";
import { createUserPrincipal } from "./auth/principal.ts";
import { createAuthWorkerServiceClient } from "./auth/auth-worker-service.ts";
import type { AppConfig } from "./config.ts";
import { itxEnv } from "./env.ts";
import { resolveProjectIdBySlug } from "./project-directory.ts";
import { ProjectCollectionRpcTarget } from "./rpc-targets.ts";
import {
  handleInboundEmail,
  MAX_INBOUND_EMAIL_BYTES,
  type InboundEmailDeps,
} from "./domains/email/inbound.ts";
import {
  EMAIL_INTEGRATION_STREAM_PATH,
  EMAIL_SENDER_CLAIMED_EVENT_TYPE,
  EMAIL_SENDER_DIRECTORY_STREAM_PATH,
  foldEmailSenderDirectory,
  normalizeEmailAddress,
} from "./domains/email/utils.ts";
import {
  integrationStreamStub,
  readAllStreamEvents,
} from "./domains/integrations/integration-streams.ts";

/**
 * The worker `email()` entrypoint's body: drain the raw message and run the
 * shared pipeline. Drops are absorbed silently (accept-and-drop): a rejected
 * unverified message would bounce, and answering spoofed mail in any form
 * makes this handler an oracle. Oversize is the one SMTP-level reject — the
 * size is known before reading the stream.
 */
export async function handleInboundEmailMessage(input: {
  config: AppConfig;
  ctx: ExecutionContext;
  message: ForwardableEmailMessage;
}): Promise<void> {
  const { config, ctx, message } = input;
  if (message.rawSize > MAX_INBOUND_EMAIL_BYTES) {
    message.setReject("Message too large.");
    return;
  }
  try {
    const rawMime = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const result = await handleInboundEmail(
      { envelopeFrom: message.from, envelopeTo: message.to, rawMime },
      inboundEmailDeps(config, ctx),
    );
    console.log("[email-ingress] inbound email handled", result);
  } catch (error) {
    // Throwing would make Cloudflare retry/bounce; the failure is ours to
    // observe, not the sender's to see.
    console.error("[email-ingress] inbound email failed", error);
  }
}

const InjectRequestBody = z.object({
  envelopeFrom: z.string().min(1),
  envelopeTo: z.string().min(1),
  /** The complete RFC 5322 message, exactly as SMTP would deliver it. */
  rawMime: z.string().min(1),
});

/**
 * Serve one request if it is the email inject lane; null means "not mine".
 * Admin-secret tier (same trust as the CLI/e2e lane): the caller crafts the
 * raw MIME including Authentication-Results, so this endpoint IS the trust
 * bypass — it must never be reachable without the admin secret.
 */
export async function handleEmailInjectApiRequest(input: {
  config: AppConfig;
  ctx: ExecutionContext;
  request: Request;
}): Promise<Response | null> {
  const url = new URL(input.request.url);
  if (url.pathname !== "/api/integrations/email/inject") return null;
  if (input.request.method !== "POST") {
    return Response.json({ error: "method not allowed" }, { status: 405 });
  }
  const admin = authenticateAdminApiSecret({ config: input.config }, input.request);
  if (!admin) return Response.json({ error: "unauthorized" }, { status: 401 });

  const body = InjectRequestBody.safeParse(await input.request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid body", issues: body.error.issues }, { status: 400 });
  }

  const result = await handleInboundEmail(body.data, inboundEmailDeps(input.config, input.ctx));
  return Response.json(result);
}

function inboundEmailDeps(config: AppConfig, ctx: ExecutionContext): InboundEmailDeps {
  return {
    config,
    resolveSenderProject: (input) => resolveSenderProject({ config, ctx, ...input }),
    lookupProjectIdBySlug: (slug) =>
      resolveProjectIdBySlug({ config, directory: itxEnv.PROJECT_DIRECTORY, identifier: slug }),
    appendEmailReceived: async ({ projectId, event }) => {
      await integrationStreamStub(projectId, EMAIL_INTEGRATION_STREAM_PATH).append(event);
    },
  };
}

/**
 * The email sender directory lookup + zero-onboarding provisioning chain.
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
async function resolveSenderProject(input: {
  config: AppConfig;
  ctx: ExecutionContext;
  address: string;
  name: string | undefined;
  allowProvision: boolean;
}): Promise<{ projectId: string; provisioned: boolean } | null> {
  const address = normalizeEmailAddress(input.address);
  const directory = () => readAllStreamEvents(null, EMAIL_SENDER_DIRECTORY_STREAM_PATH);
  const claimed = foldEmailSenderDirectory(await directory()).get(address);
  if (claimed !== undefined) return { projectId: claimed, provisioned: false };
  if (!input.allowProvision) return null;

  const localPart = address.slice(0, address.lastIndexOf("@"));
  const displayName = input.name?.trim() || localPart;
  const authClient = createAuthWorkerServiceClient({ config: input.config });

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

  const auth = provisionedUserAuthContext(
    input.config,
    createUserPrincipal({
      userId: user.id,
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
    return args.projectId!;
  };

  let projectId: string;
  try {
    projectId = await createProject(projectSlug);
  } catch (error) {
    if (!/conflict|already taken|already exists/i.test(String(error))) throw error;
    projectId = await createProject(slugifyWithSuffix(localPart));
  }

  await integrationStreamStub(null, EMAIL_SENDER_DIRECTORY_STREAM_PATH).append({
    type: EMAIL_SENDER_CLAIMED_EVENT_TYPE,
    idempotencyKey: `email-sender-claim:${address}`,
    payload: { address, projectId, userId: user.id, organizationSlug: organization.slug },
  });

  const winner = foldEmailSenderDirectory(await directory()).get(address);
  if (winner !== undefined && winner !== projectId) {
    console.warn(
      `[email-ingress] lost sender-claim race for ${address}: provisioned ${projectId}, adopting ${winner} (orphaned org ${organization.slug})`,
    );
    return { projectId: winner, provisioned: false };
  }
  return { projectId, provisioned: true };
}
