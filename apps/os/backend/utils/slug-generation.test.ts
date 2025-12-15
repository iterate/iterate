import { describe, expect, test } from "vitest";
import { generateSlugFromEmail, generateUniqueSlug } from "./slug-generation.ts";

describe("generateSlugFromEmail", () => {
  test.for([
    { email: "john.doe@gmail.com", expected: "john-doe" },
    { email: "john.doe@googlemail.com", expected: "john-doe" },
    { email: "user@outlook.com", expected: "user" },
    { email: "test_user@hotmail.com", expected: "test-user" },
    { email: "hello@yahoo.com", expected: "hello" },
    { email: "person@protonmail.com", expected: "person" },
    { email: "user@icloud.com", expected: "user" },
  ])("consumer email: $email → $expected", ({ email, expected }) => {
    expect(generateSlugFromEmail(email)).toBe(expected);
  });

  test.for([
    { email: "john@acme.com", expected: "acme" },
    { email: "ceo@company.co.uk", expected: "company" },
    { email: "dev@my-startup.io", expected: "my-startup" },
    { email: "hello@iterate.com", expected: "iterate" },
    { email: "user@test.org", expected: "test" },
    { email: "admin@example.net", expected: "example" },
    { email: "contact@big-corp.co", expected: "big-corp" },
  ])("company email: $email → $expected", ({ email, expected }) => {
    expect(generateSlugFromEmail(email)).toBe(expected);
  });

  test.for([
    { email: "USER@ACME.COM", expected: "acme" },
    { email: "John.Doe@Gmail.COM", expected: "john-doe" },
  ])("handles case insensitivity: $email → $expected", ({ email, expected }) => {
    expect(generateSlugFromEmail(email)).toBe(expected);
  });

  test.for([
    { email: "user+tag@gmail.com", expected: "user-tag" },
    { email: "first.last@company.com", expected: "company" },
    { email: "user_name@startup.io", expected: "startup" },
  ])("handles special characters: $email → $expected", ({ email, expected }) => {
    expect(generateSlugFromEmail(email)).toBe(expected);
  });
});

describe("generateUniqueSlug", () => {
  test("returns base slug when not taken", async () => {
    const result = await generateUniqueSlug("acme", async () => false);
    expect(result).toBe("acme");
  });

  test("appends -2 when base slug is taken", async () => {
    const takenSlugs = new Set(["acme"]);
    const result = await generateUniqueSlug("acme", async (slug) => takenSlugs.has(slug));
    expect(result).toBe("acme-2");
  });

  test("increments suffix until unique", async () => {
    const takenSlugs = new Set(["acme", "acme-2", "acme-3"]);
    const result = await generateUniqueSlug("acme", async (slug) => takenSlugs.has(slug));
    expect(result).toBe("acme-4");
  });
});
