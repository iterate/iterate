import { describe, expect, test } from "vitest";
import { isFreeEmailDomain, FREE_EMAIL_DOMAINZ } from "./free-email-domains.ts";

describe("isFreeEmailDomain", () => {
  test("returns true for common free email providers", () => {
    expect(isFreeEmailDomain("gmail.com")).toBe(true);
    expect(isFreeEmailDomain("yahoo.com")).toBe(true);
    expect(isFreeEmailDomain("hotmail.com")).toBe(true);
    expect(isFreeEmailDomain("outlook.com")).toBe(true);
    expect(isFreeEmailDomain("icloud.com")).toBe(true);
    expect(isFreeEmailDomain("protonmail.com")).toBe(true);
    expect(isFreeEmailDomain("aol.com")).toBe(true);
  });

  test("returns true for regional providers", () => {
    expect(isFreeEmailDomain("gmx.de")).toBe(true);
    expect(isFreeEmailDomain("mail.ru")).toBe(true);
    expect(isFreeEmailDomain("qq.com")).toBe(true);
    expect(isFreeEmailDomain("libero.it")).toBe(true);
  });

  test("returns false for work domains", () => {
    expect(isFreeEmailDomain("iterate.com")).toBe(false);
    expect(isFreeEmailDomain("acme.com")).toBe(false);
    expect(isFreeEmailDomain("company.io")).toBe(false);
    expect(isFreeEmailDomain("startup.co")).toBe(false);
  });

  test("is case insensitive", () => {
    expect(isFreeEmailDomain("Gmail.com")).toBe(true);
    expect(isFreeEmailDomain("YAHOO.COM")).toBe(true);
    expect(isFreeEmailDomain("HotMail.Com")).toBe(true);
  });

  test("has a reasonable number of domains", () => {
    expect(FREE_EMAIL_DOMAINZ.size).toBeGreaterThan(50);
  });
});
