import { minimatch } from "minimatch";

export function parseSignupAllowlist(value: string): string[] {
  return value
    .split(",")
    .map((pattern) => pattern.trim().toLowerCase())
    .filter((pattern) => pattern.length > 0);
}

export function matchesSignupAllowlist(email: string, patterns: string[]): boolean {
  return patterns.some((pattern) => minimatch(email.toLowerCase(), pattern));
}

export function isSignupAllowed(email: string, allowlist: string): boolean {
  return matchesSignupAllowlist(email, parseSignupAllowlist(allowlist));
}
