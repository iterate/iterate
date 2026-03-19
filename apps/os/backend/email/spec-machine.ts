export type SpecMachineInfo = {
  baseUrl: string;
};

const SPEC_MACHINE_DOMAIN = "magic.example.com";
const SPEC_MACHINE_PREFIX = "specmachine.";

export function parseSpecMachineEmail(email: string): SpecMachineInfo | null {
  const trimmed = email.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex === -1) {
    return null;
  }

  const localPart = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1).toLowerCase();
  if (!localPart || domain !== SPEC_MACHINE_DOMAIN) {
    return null;
  }

  if (!localPart.startsWith(SPEC_MACHINE_PREFIX)) {
    return null;
  }

  const encoded = localPart.slice(SPEC_MACHINE_PREFIX.length);
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8")) as {
      baseUrl?: unknown;
    };
    if (typeof decoded.baseUrl !== "string") {
      return null;
    }

    const baseUrl = new URL(decoded.baseUrl);
    if (!["http:", "https:"].includes(baseUrl.protocol)) {
      return null;
    }

    return {
      baseUrl: baseUrl.toString(),
    };
  } catch {
    return null;
  }
}

export function buildSpecMachineEmail(params: { baseUrl: string }): string {
  const encoded = Buffer.from(JSON.stringify({ baseUrl: params.baseUrl }), "utf-8").toString(
    "base64url",
  );
  return `${SPEC_MACHINE_PREFIX}${encoded}@${SPEC_MACHINE_DOMAIN}`;
}
