export function isEmailAllowed(email: string, allowlist: string): boolean {
  const normalizedEmail = email.trim().toLowerCase();
  const patterns = allowlist
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);

  if (patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    if (pattern.startsWith("*@")) {
      const domain = pattern.slice(2);
      if (normalizedEmail.endsWith("@" + domain)) {
        return true;
      }
    } else {
      if (normalizedEmail === pattern) {
        return true;
      }
    }
  }

  return false;
}
