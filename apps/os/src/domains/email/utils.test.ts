import { describe, expect, it } from "vitest";
import { buildProjectEmailMessage, emailAddressForProject } from "./utils.ts";

describe("emailAddressForProject", () => {
  it("is <slug>@<domain>", () => {
    expect(emailAddressForProject({ slug: "acme", domain: "iterate.app" })).toBe(
      "acme@iterate.app",
    );
  });
});

describe("buildProjectEmailMessage", () => {
  const projectAddress = "acme@iterate.app";
  const projectName = "Acme";

  it("defaults from to the project's own address", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: { to: "user@example.com", subject: "Hi", text: "Hello" },
    });
    expect(message).toEqual({
      from: { email: "acme@iterate.app", name: "Acme" },
      to: "user@example.com",
      subject: "Hi",
      text: "Hello",
    });
  });

  it("accepts an explicit from matching the project address case-insensitively", () => {
    const message = buildProjectEmailMessage({
      projectAddress,
      projectName,
      request: { to: "user@example.com", subject: "Hi", text: "Hello", from: "ACME@iterate.app" },
    });
    expect(message.from).toEqual({ email: "ACME@iterate.app", name: "Acme" });
  });

  it("rejects sending as anyone else", () => {
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi", text: "x", from: "other@iterate.app" },
      }),
    ).toThrow(/project's own address/);
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi", text: "x", from: "acme@evil.com" },
      }),
    ).toThrow(/project's own address/);
  });

  it("requires a body", () => {
    expect(() =>
      buildProjectEmailMessage({
        projectAddress,
        projectName,
        request: { to: "user@example.com", subject: "Hi" },
      }),
    ).toThrow(/text and\/or html/);
  });
});
