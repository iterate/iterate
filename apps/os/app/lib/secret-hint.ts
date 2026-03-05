/**
 * Simple heuristics to hint that a value might be a secret.
 * Used to remind users to check "Store as secret" when adding env vars.
 */

/** Key name patterns that suggest the value should be secret */
const SECRET_KEY_PATTERNS = [
  /api[_-]?key/i,
  /access[_-]?token/i,
  /_secret$/i, // ends with _SECRET
  /^secret_/i, // starts with SECRET_
  /password/i,
  /private[_-]?key/i,
  /auth[_-]?token/i,
  /bearer/i,
  /credential/i,
];

/** Value patterns that match known API key formats */
const SECRET_VALUE_PATTERNS = [
  // OpenAI
  /^sk-[a-zA-Z0-9]{20,}$/,
  // Anthropic
  /^sk-ant-[a-zA-Z0-9-]{20,}$/,
  // Stripe (live and test keys)
  /^sk_(live|test)_[0-9a-zA-Z]{24}$/,
  /^rk_(live|test)_[0-9a-zA-Z]{24}$/,
  // AWS
  /^AKIA[0-9A-Z]{16}$/,
  // Google
  /^AIza[0-9A-Za-z\-_]{35}$/,
  // Slack
  /^xox[pboa]-[0-9]{10,}-[0-9a-zA-Z-]+$/,
  // GitHub (classic token)
  /^ghp_[a-zA-Z0-9]{36}$/,
  // GitHub (fine-grained)
  /^github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}$/,
  // Mailgun
  /^key-[0-9a-zA-Z]{32}$/,
  // Twilio
  /^SK[0-9a-fA-F]{32}$/,
  // Private key header
  /^-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/,
  // JWT (often contains secrets)
  /^eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/=]*$/,
];

/** Patterns that look like structured data, not random secrets */
const STRUCTURED_PATTERNS = [
  /^https?:\/\//, // URLs
  /^postgres(ql)?:\/\//, // Database URLs
  /^mysql:\/\//, // MySQL URLs
  /^mongodb(\+srv)?:\/\//, // MongoDB URLs
  /^redis:\/\//, // Redis URLs
  /^[a-z0-9-]+\.[a-z]{2,}$/i, // Domain names
];

/**
 * Check if a string looks random (high Shannon entropy per character).
 * Returns true if the string appears to be a random token/key.
 */
function looksRandom(str: string): boolean {
  if (!str || str.length < 20) return false;

  // Skip structured data like URLs
  if (STRUCTURED_PATTERNS.some((p) => p.test(str))) return false;

  // Calculate character frequency
  const freq: Record<string, number> = {};
  for (const char of str) {
    freq[char] = (freq[char] || 0) + 1;
  }

  // Shannon entropy: H = -Σ p(x) * log2(p(x))
  let entropy = 0;
  const len = str.length;
  for (const char in freq) {
    const p = freq[char] / len;
    entropy -= p * Math.log2(p);
  }

  // Fairly permissive: entropy > 2.5 bits/char + unique ratio > 25%
  // This catches most passwords and tokens while avoiding obvious non-secrets
  // We prefer false positives (annoying) over false negatives (security risk)
  const uniqueRatio = Object.keys(freq).length / len;
  return entropy > 2.5 && uniqueRatio > 0.25;
}

export type SecretHint = {
  looksLikeSecret: boolean;
  reason: "key-name" | "value-pattern" | "high-entropy" | null;
};

/**
 * Check if a key/value pair looks like it might be a secret.
 * Returns a hint to show the user.
 */
export function getSecretHint(key: string, value: string): SecretHint {
  // Check key name
  if (SECRET_KEY_PATTERNS.some((p) => p.test(key))) {
    return { looksLikeSecret: true, reason: "key-name" };
  }

  // Check value against known patterns
  if (SECRET_VALUE_PATTERNS.some((p) => p.test(value))) {
    return { looksLikeSecret: true, reason: "value-pattern" };
  }

  // Check if value looks random (high entropy per character)
  if (looksRandom(value)) {
    return { looksLikeSecret: true, reason: "high-entropy" };
  }

  return { looksLikeSecret: false, reason: null };
}
