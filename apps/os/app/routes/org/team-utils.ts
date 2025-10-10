export type OrganizationMemberListItem = {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: "member" | "admin" | "owner" | "guest" | "external";
  createdAt: string;
};

export function sortMembersWithCurrentFirst<T extends { userId: string }>(
  members: T[],
  currentUserId: string,
): T[] {
  // Stable sort in Node 24: only move current user to the front
  return [...members].sort((a, b) => {
    if (a.userId === currentUserId && b.userId !== currentUserId) return -1;
    if (b.userId === currentUserId && a.userId !== currentUserId) return 1;
    return 0;
  });
}
