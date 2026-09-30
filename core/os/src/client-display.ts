import { z } from "zod";

// App-supplied identifiers, never a publisher-verification assertion.
export const ClientDisplayUrl = z.url({ protocol: /^https$/ }).refine((value) => {
  // zod runs a refine even after z.url() has failed, where `new URL` would throw
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return !url.username && !url.password;
});

/** Snapshot branding at approval so listing sessions needs no external metadata requests. */
export function clientDisplay(
  client: { clientName?: string; clientUri?: string; logoUri?: string } | null | undefined,
  clientId: string,
) {
  const logo = ClientDisplayUrl.safeParse(client?.logoUri);
  const website = ClientDisplayUrl.safeParse(client?.clientUri);
  const metadata = ClientDisplayUrl.safeParse(clientId);
  const domainUrl = metadata.success ? metadata.data : website.success ? website.data : null;
  return {
    clientName: client?.clientName || clientId,
    logoUri: logo.success ? logo.data : undefined,
    clientDomain: domainUrl ? new URL(domainUrl).host : undefined,
  };
}
