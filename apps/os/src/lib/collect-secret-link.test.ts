import { describe, expect, test } from "vitest";
import { defaultParseSearch } from "@tanstack/react-router";
import { CollectSecretSearch, buildCollectSecretUrl } from "./collect-secret-link.ts";

// The whole point of co-locating build + parse: prove the encoding survives
// the router's ACTUAL search parser (which JSON-parses each param and falls
// back to the raw string — so "12345" without JSON encoding would come back
// as a number and fail the zod schema, killing the link).
const roundTrip = (search: CollectSecretSearch) => {
  const url = new URL(
    buildCollectSecretUrl({ baseUrl: "https://os.iterate.com", projectSlug: "demo", search }),
  );
  expect(url.pathname).toBe("/collect-secret/demo");
  return CollectSecretSearch.parse(defaultParseSearch(url.search));
};

describe("collect-secret link round-trip", () => {
  test("full link survives the router's search parser exactly", () => {
    const search: CollectSecretSearch = {
      path: "/secrets/acme",
      egress: ["https://api.acme.com/", "https://auth.acme.com"],
      description: "Acme API key (Settings → API)",
      notify: "/agents/helper",
    };
    expect(roundTrip(search)).toEqual(search);
  });

  test.each(["482913", "true", "null", '"quoted"', "[not json", "{}"])(
    "JSON-ish description %j comes back as the same string",
    (description) => {
      const parsed = roundTrip({ path: "/secrets/x", egress: ["https://a.example"], description });
      expect(parsed.description).toBe(description);
    },
  );

  test("minimal link: no description, no notify, egress defaults to []", () => {
    const parsed = roundTrip({ path: "/secrets/x", egress: [] });
    expect(parsed).toEqual({ path: "/secrets/x", egress: [] });
  });

  test("tampered params are rejected by the schema, not misread", () => {
    expect(() =>
      CollectSecretSearch.parse(defaultParseSearch("?path=/not-secrets/x&egress=[]")),
    ).toThrow();
    expect(() =>
      CollectSecretSearch.parse(
        defaultParseSearch("?path=/secrets/x&egress=[]&notify=/not-agents/x"),
      ),
    ).toThrow();
  });
});
