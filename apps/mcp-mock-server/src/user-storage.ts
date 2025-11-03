import type { KVNamespace } from "@cloudflare/workers-types";

export interface MockUser {
  userId: string;
  userName: string;
  email: string;
  passwordHash: string;
  createdAt: number;
}

const USER_PREFIX = "mock-user:";

function hashPassword(password: string): string {
  return btoa(password);
}

export async function getOrCreateUser(
  kv: KVNamespace,
  email: string,
  password: string,
): Promise<MockUser> {
  const key = `${USER_PREFIX}${email}`;
  const existing = await kv.get<MockUser>(key, "json");

  if (existing) {
    const passwordHash = hashPassword(password);
    if (existing.passwordHash === passwordHash) {
      return existing;
    }
    throw new Error("Invalid password");
  }

  const id = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  const user: MockUser = {
    userId: `mock-user-${id}`,
    userName: email.split("@")[0] || "Mock User",
    email,
    passwordHash: hashPassword(password),
    createdAt: Date.now(),
  };

  await kv.put(key, JSON.stringify(user));
  return user;
}

export function generateAutoUser(): Omit<MockUser, "passwordHash"> {
  const id = `auto-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  return {
    userId: `mock-user-${id}`,
    userName: "Mock Test User",
    email: `mock-${id}@example.com`,
    createdAt: Date.now(),
  };
}
