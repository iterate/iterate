// src/email/contract.ts — EMAIL: a project's mail, at `<slug>@<email domain>` (`<slug>@iterate.app`
// on prd), and for the project wildcard's project at its domain too (`hello@iterate.com`). Every
// message in or out lands on ONE context of the project, `/integrations/email`: inbound mail from
// Cloudflare Email Routing through the worker's `email()` handler as `email/received`, and each
// `itx.email.send` as `email/sent`, both appended by the platform (integrations/email.ts). Their
// events and the threads processor.ts folds them into are `iterate/email`'s contract, which a config
// repo reads too; durable-object.ts hosts the fold as the first-party facet `email` on that context.
// An attachment's bytes are a project file (`itx.files.get(path)`), under `/email/`.
import type { IngressRouting } from "iterate/project-ingress";

/** The context every message of a project lands on, and the `email` facet folds. */
export const EMAIL_PATH = "/integrations/email";

/** The domain a project's mail is on: the hostname the project wildcard is on (`iterate.app` on
 *  prd). Null where projects are paths on the platform's origin (a preview, a self-host without a
 *  wildcard): no project has an address there. */
export function emailDomainOf(ingressRouting: IngressRouting) {
  return ingressRouting?.type === "subdomains" ? ingressRouting.hostname : null;
}
