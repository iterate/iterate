import { describe, test, expect } from "vitest";
import { sortMembersWithCurrentFirst, type OrganizationMemberListItem } from "./team-utils.ts";

describe("sortMembersWithCurrentFirst", () => {
  const base = (overrides: Partial<OrganizationMemberListItem>): OrganizationMemberListItem => ({
    id: overrides.id ?? crypto.randomUUID(),
    userId: overrides.userId ?? "uX",
    name: overrides.name ?? "User X",
    email: overrides.email ?? "x@example.com",
    image: null,
    role: overrides.role ?? "member",
    createdAt: new Date().toISOString(),
  });

  test("moves current user to the front only", () => {
    const currentUserId = "me";
    const members: OrganizationMemberListItem[] = [
      base({ id: "1", userId: "a", name: "Alice" }),
      base({ id: "2", userId: currentUserId, name: "Me" }),
      base({ id: "3", userId: "b", name: "Bob" }),
    ];

    const sorted = sortMembersWithCurrentFirst(members, currentUserId);

    expect(sorted.map((m) => m.userId)).toEqual([currentUserId, "a", "b"]);
  });

  test("keeps order of non-current members stable", () => {
    const currentUserId = "me";
    const members: OrganizationMemberListItem[] = [
      base({ id: "1", userId: "a", name: "Alice" }),
      base({ id: "2", userId: "b", name: "Bob" }),
      base({ id: "3", userId: currentUserId, name: "Me" }),
      base({ id: "4", userId: "c", name: "Cara" }),
    ];

    const sorted = sortMembersWithCurrentFirst(members, currentUserId);

    expect(sorted.map((m) => m.userId)).toEqual([currentUserId, "a", "b", "c"]);
  });

  test("handles when current user is not in list", () => {
    const members: OrganizationMemberListItem[] = [
      base({ id: "1", userId: "a" }),
      base({ id: "2", userId: "b" }),
    ];

    const sorted = sortMembersWithCurrentFirst(members, "me");

    expect(sorted.map((m) => m.userId)).toEqual(["a", "b"]);
  });
});
