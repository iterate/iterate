export type SpecMachineInfo = {
  providerBaseUrl: string;
};

const SPEC_MACHINE_DOMAIN = "nustom.com";
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
    const decoded = JSON.parse(Buffer.from(encoded, "hex").toString("utf-8")) as {
      providerBaseUrl?: unknown;
      baseUrl?: unknown;
    };
    const rawBaseUrl = decoded.providerBaseUrl ?? decoded.baseUrl;
    if (typeof rawBaseUrl !== "string") {
      return null;
    }

    const providerBaseUrl = new URL(rawBaseUrl);
    if (!["http:", "https:"].includes(providerBaseUrl.protocol)) {
      return null;
    }

    return {
      providerBaseUrl: providerBaseUrl.toString(),
    };
  } catch {
    return null;
  }
}

export function buildSpecMachineEmail(params: { providerBaseUrl: string }): string {
  const encoded = Buffer.from(
    JSON.stringify({ providerBaseUrl: params.providerBaseUrl }),
    "utf-8",
  ).toString("hex");
  return `${SPEC_MACHINE_PREFIX}${encoded}@${SPEC_MACHINE_DOMAIN}`;
}
