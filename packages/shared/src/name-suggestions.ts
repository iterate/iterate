// Best-effort heuristics for proposing human-friendly names during
// onboarding. They only need to produce a plausible first draft that the user
// can edit — improve freely.

/** Email providers whose domain says nothing about the user's team. */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "hey.com",
  "fastmail.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "yandex.com",
  "zoho.com",
]);

/**
 * Proposes an organization name for first-run onboarding.
 *
 * Prefer the OAuth display name when the provider gave us one
 * ("Jonas Templestein" → "Jonas Templestein's Organization"). Fall back to
 * the email-only heuristic when name is missing.
 */
export function suggestOrganizationName(input: {
  name?: string | null;
  email?: string | null;
}): string {
  const displayName = input.name?.trim();
  if (displayName) {
    return `${displayName}'s Organization`;
  }
  return suggestOrganizationNameFromEmail(input.email ?? "");
}

/**
 * Proposes an organization name from an email address: the company domain's
 * first label when the domain looks like a company ("jonas@nustom.com" →
 * "Nustom"), otherwise the local part ("jane.doe+work@gmail.com" → "Jane
 * Doe"). Returns "" when nothing sensible can be derived.
 */
export function suggestOrganizationNameFromEmail(email: string): string {
  const [rawLocalPart, rawDomain] = email.trim().toLowerCase().split("@");
  if (!rawLocalPart || !rawDomain) return "";

  if (!GENERIC_EMAIL_DOMAINS.has(rawDomain)) {
    return titleCaseWords(rawDomain.split(".")[0] ?? "");
  }

  return titleCaseWords(rawLocalPart.split("+")[0] ?? "");
}

function titleCaseWords(value: string): string {
  return value
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
