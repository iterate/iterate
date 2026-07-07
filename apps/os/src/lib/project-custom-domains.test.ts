import { describe, expect, it } from "vitest";
import { primaryActiveCustomDomainHostname } from "./project-custom-domains.ts";
import type { ProjectCustomDomain, ProjectCustomDomainStatus } from "~/types.ts";

describe("primaryActiveCustomDomainHostname", () => {
  it("returns null when there is no active custom domain", () => {
    expect(primaryActiveCustomDomainHostname()).toBeNull();
    expect(
      primaryActiveCustomDomainHostname([domain("garple.com", "pending_validation")]),
    ).toBeNull();
  });

  it("prefers active apex-like domains over active subdomains", () => {
    expect(
      primaryActiveCustomDomainHostname([
        domain("api.garple.com"),
        domain("www.garple.com"),
        domain("garple.com"),
      ]),
    ).toBe("garple.com");
  });

  it("breaks ties predictably", () => {
    expect(
      primaryActiveCustomDomainHostname([domain("zeta.example.com"), domain("api.example.com")]),
    ).toBe("api.example.com");
  });
});

function domain(
  hostname: string,
  status: ProjectCustomDomainStatus = "active",
): ProjectCustomDomain {
  return {
    certificateDelegationCname: null,
    cloudflareHostnameId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    error: null,
    hostname,
    hostnameStatus: null,
    ownershipVerification: null,
    sslStatus: null,
    status,
    updatedAt: "2026-01-01T00:00:00.000Z",
    validationRecords: [],
    wildcard: true,
  };
}
