// The synthetic-inbound-email lane: POST /api/integrations/email/inject,
// admin-secret gated, served by the API worker pipeline next to the Slack
// webhook lanes. It fakes an InboundEmailDelivery from
// `{envelopeFrom, envelopeTo, rawMime}` over the exact handleInboundEmail the
// real `email()` entrypoint runs — the e2e/local-dev stand-in for MX, since
// nothing can trigger `email()` without real Email Routing. The caller crafts
// the raw MIME including Authentication-Results, so this endpoint IS the
// trust bypass: it must never be reachable without the admin secret.

import { z } from "zod";
import { authenticateAdminApiSecret } from "../../auth/admin.ts";
import type { AppConfig } from "../../config.ts";
import { handleInboundEmail } from "./email-ingress.ts";

const InjectRequestBody = z.object({
  envelopeFrom: z.string().min(1),
  envelopeTo: z.string().min(1),
  /** The complete RFC 5322 message, exactly as SMTP would deliver it. */
  rawMime: z.string().min(1),
});

/** Serve one request if it is the email inject lane; null means "not mine". */
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

  let rejectMessage: string | null = null;
  const result = await handleInboundEmail(
    {
      from: body.data.envelopeFrom,
      to: body.data.envelopeTo,
      raw: body.data.rawMime,
      rawSize: new TextEncoder().encode(body.data.rawMime).byteLength,
      setReject: (reason) => {
        rejectMessage = reason;
      },
    },
    input.ctx,
  );
  return Response.json({ ...result, ...(rejectMessage === null ? {} : { rejectMessage }) });
}
