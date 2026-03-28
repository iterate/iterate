import { isFreeEmailDomain } from "../utils/free-email-domains.ts";
import { slugify } from "../utils/slug.ts";

export function parseSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

export function parseSender(from: string): { email: string; name: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return {
      name: match[1].trim(),
      email: match[2].trim().toLowerCase(),
    };
  }

  const email = from.trim().toLowerCase();
  return { email, name: email };
}

export function parseRecipientLocal(to: string): string {
  const email = to.includes("<") ? parseSenderEmail(to) : to.trim().toLowerCase();
  return email.split("@")[0] ?? "";
}

export function getDefaultOrganizationNameFromEmail(email: string): string {
  const [localPart = "", domain = ""] = email.trim().toLowerCase().split("@");

  if (isFreeEmailDomain(domain)) {
    return slugify(localPart.split("+")[0] ?? localPart);
  }

  return slugify(domain.replace(/\.com$/, ""));
}
