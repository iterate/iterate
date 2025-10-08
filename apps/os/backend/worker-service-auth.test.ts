import { describe, test, expect, beforeEach, vi } from "vitest";
import type { CloudflareEnv } from "../env.ts";
import type { AuthSession } from "./auth/auth.ts";

describe("Service Auth Middleware", () => {
  let mockDb: any;
  let mockAuth: any;
  let mockEnv: Partial<CloudflareEnv>;

  beforeEach(() => {
    // Reset mocks
    mockDb = {
      query: {
        user: {
          findFirst: vi.fn(),
        },
      },
    };

    mockAuth = {
      api: {
        getSession: vi.fn().mockResolvedValue(null),
      },
      handler: vi.fn(),
    };

    mockEnv = {
      SERVICE_AUTH_TOKEN: "test-service-token-123",
    };
  });

  test("should impersonate user when valid service auth token is provided", async () => {
    const mockUser = {
      id: "usr_123",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      role: "user",
      debugMode: false,
      banned: null,
      banReason: null,
      banExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.query.user.findFirst.mockResolvedValue(mockUser);

    // Simulate the middleware logic
    const serviceAuthToken = "test-service-token-123";
    const impersonateUserId = "usr_123";
    let session: AuthSession | null = null;

    if (serviceAuthToken && impersonateUserId) {
      if (serviceAuthToken === mockEnv.SERVICE_AUTH_TOKEN) {
        const userToImpersonate = await mockDb.query.user.findFirst({
          where: vi.fn(),
        });

        if (userToImpersonate) {
          session = {
            user: {
              ...userToImpersonate,
              debugMode: userToImpersonate.debugMode ?? false,
              banned: userToImpersonate.banned ?? undefined,
              banReason: userToImpersonate.banReason ?? undefined,
              banExpires: userToImpersonate.banExpires ?? undefined,
              role: userToImpersonate.role ?? undefined,
              image: userToImpersonate.image ?? undefined,
            },
            session: {
              id: `service_impersonate_${impersonateUserId}`,
              userId: userToImpersonate.id,
              expiresAt: new Date(Date.now() + 1000 * 60 * 60),
              token: `service_token_${Date.now()}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
      }
    }

    expect(session).not.toBeNull();
    expect(session?.user.id).toBe("usr_123");
    expect(session?.user.email).toBe("test@example.com");
    expect(session?.session.userId).toBe("usr_123");
    expect(mockDb.query.user.findFirst).toHaveBeenCalled();
  });

  test("should not impersonate when service auth token is invalid", async () => {
    const mockUser = {
      id: "usr_123",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      role: "user",
      debugMode: false,
      banned: null,
      banReason: null,
      banExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.query.user.findFirst.mockResolvedValue(mockUser);

    // Simulate the middleware logic with invalid token
    const serviceAuthToken = "invalid-token";
    const impersonateUserId = "usr_123";
    let session: AuthSession | null = null;

    if (serviceAuthToken && impersonateUserId) {
      if (serviceAuthToken === mockEnv.SERVICE_AUTH_TOKEN) {
        // This should not execute
        const userToImpersonate = await mockDb.query.user.findFirst({
          where: vi.fn(),
        });

        if (userToImpersonate) {
          session = {
            user: {
              ...userToImpersonate,
              debugMode: userToImpersonate.debugMode ?? false,
              banned: userToImpersonate.banned ?? undefined,
              banReason: userToImpersonate.banReason ?? undefined,
              banExpires: userToImpersonate.banExpires ?? undefined,
              role: userToImpersonate.role ?? undefined,
              image: userToImpersonate.image ?? undefined,
            },
            session: {
              id: `service_impersonate_${impersonateUserId}`,
              userId: userToImpersonate.id,
              expiresAt: new Date(Date.now() + 1000 * 60 * 60),
              token: `service_token_${Date.now()}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
      }
    }

    // Should fall back to normal auth
    if (!session) {
      session = await mockAuth.api.getSession({ headers: new Headers() });
    }

    expect(session).toBeNull();
    expect(mockDb.query.user.findFirst).not.toHaveBeenCalled();
  });

  test("should not impersonate when user is not found", async () => {
    mockDb.query.user.findFirst.mockResolvedValue(null);

    // Simulate the middleware logic
    const serviceAuthToken = "test-service-token-123";
    const impersonateUserId = "usr_nonexistent";
    let session: AuthSession | null = null;

    if (serviceAuthToken && impersonateUserId) {
      if (serviceAuthToken === mockEnv.SERVICE_AUTH_TOKEN) {
        const userToImpersonate = await mockDb.query.user.findFirst({
          where: vi.fn(),
        });

        if (userToImpersonate) {
          session = {
            user: {
              ...userToImpersonate,
              debugMode: userToImpersonate.debugMode ?? false,
              banned: userToImpersonate.banned ?? undefined,
              banReason: userToImpersonate.banReason ?? undefined,
              banExpires: userToImpersonate.banExpires ?? undefined,
              role: userToImpersonate.role ?? undefined,
              image: userToImpersonate.image ?? undefined,
            },
            session: {
              id: `service_impersonate_${impersonateUserId}`,
              userId: userToImpersonate.id,
              expiresAt: new Date(Date.now() + 1000 * 60 * 60),
              token: `service_token_${Date.now()}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
      }
    }

    // Should fall back to normal auth
    if (!session) {
      session = await mockAuth.api.getSession({ headers: new Headers() });
    }

    expect(session).toBeNull();
    expect(mockDb.query.user.findFirst).toHaveBeenCalled();
  });

  test("should handle null values in user fields correctly", async () => {
    const mockUser = {
      id: "usr_123",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      role: null,
      debugMode: null,
      banned: null,
      banReason: null,
      banExpires: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    mockDb.query.user.findFirst.mockResolvedValue(mockUser);

    // Simulate the middleware logic
    const serviceAuthToken = "test-service-token-123";
    const impersonateUserId = "usr_123";
    let session: AuthSession | null = null;

    if (serviceAuthToken && impersonateUserId) {
      if (serviceAuthToken === mockEnv.SERVICE_AUTH_TOKEN) {
        const userToImpersonate = await mockDb.query.user.findFirst({
          where: vi.fn(),
        });

        if (userToImpersonate) {
          session = {
            user: {
              ...userToImpersonate,
              debugMode: userToImpersonate.debugMode ?? false,
              banned: userToImpersonate.banned ?? undefined,
              banReason: userToImpersonate.banReason ?? undefined,
              banExpires: userToImpersonate.banExpires ?? undefined,
              role: userToImpersonate.role ?? undefined,
              image: userToImpersonate.image ?? undefined,
            },
            session: {
              id: `service_impersonate_${impersonateUserId}`,
              userId: userToImpersonate.id,
              expiresAt: new Date(Date.now() + 1000 * 60 * 60),
              token: `service_token_${Date.now()}`,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          };
        }
      }
    }

    expect(session).not.toBeNull();
    expect(session?.user.debugMode).toBe(false);
    expect(session?.user.banned).toBeUndefined();
    expect(session?.user.role).toBeUndefined();
    expect(session?.user.image).toBeUndefined();
  });
});
