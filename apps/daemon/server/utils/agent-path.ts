const SEGMENT_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface PathValidationResult {
  valid: boolean;
  error?: string;
  normalizedPath?: string;
}

export function validateAgentPath(path: string): PathValidationResult {
  if (!path.startsWith("/")) {
    return { valid: false, error: `Path must start with '/'. Got: "${path}"` };
  }

  if (path === "/") {
    return { valid: false, error: `Path '/' is not valid. Must have at least one segment.` };
  }

  const segments = path.slice(1).split("/");

  for (const segment of segments) {
    if (!segment) {
      return { valid: false, error: `Path contains empty segment. Got: "${path}"` };
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      return {
        valid: false,
        error: `Invalid segment "${segment}". Must be lowercase alphanumeric with dashes.`,
      };
    }
  }

  return { valid: true, normalizedPath: path };
}

export function extractAgentPathFromUrl(url: string, prefix: string): string | null {
  if (!url.startsWith(prefix)) return null;
  const remainder = url.slice(prefix.length);
  if (!remainder || remainder === "/") return null;
  return remainder.startsWith("/") ? remainder : `/${remainder}`;
}
