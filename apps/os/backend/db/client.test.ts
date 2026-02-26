import { describe, it, expect } from "vitest";
import { isTransientError } from "./client.ts";

/** Helper to create an Error with a `.code` property, mimicking pg-protocol's DatabaseError. */
function pgError(message: string, code: string): Error {
  const err = new Error(message);
  (err as Error & { code: string }).code = code;
  return err;
}

/** Helper to create a Drizzle-style wrapper error with a `.cause`. */
function wrappedError(message: string, cause: Error): Error {
  const err = new Error(message);
  err.cause = cause;
  return err;
}

describe("isTransientError", () => {
  it("returns true for connection terminated errors", () => {
    expect(isTransientError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("returns true for connection timeout errors", () => {
    expect(isTransientError(new Error("connection timeout expired"))).toBe(true);
  });

  it("returns true for ECONNRESET errors", () => {
    expect(isTransientError(new Error("read ECONNRESET"))).toBe(true);
  });

  it("returns true for ECONNREFUSED errors", () => {
    expect(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
  });

  it("returns true for socket hang up errors", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  it("returns true for WebSocket errors", () => {
    expect(
      isTransientError(new Error("WebSocket was closed before the connection was established")),
    ).toBe(true);
  });

  it("returns true for fetch failed errors", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  describe("Postgres SQLSTATE codes on err.code", () => {
    it("returns true for connection_failure (08006)", () => {
      expect(isTransientError(pgError("connection_failure", "08006"))).toBe(true);
    });

    it("returns true for sqlclient_unable_to_establish_sqlconnection (08001)", () => {
      expect(isTransientError(pgError("could not connect", "08001"))).toBe(true);
    });

    it("returns true for connection_does_not_exist (08003)", () => {
      expect(isTransientError(pgError("connection does not exist", "08003"))).toBe(true);
    });

    it("returns true for admin_shutdown (57P01)", () => {
      expect(isTransientError(pgError("terminating connection due to administrator command", "57P01"))).toBe(true);
    });

    it("returns true for too_many_connections (53300)", () => {
      expect(isTransientError(pgError("too many connections", "53300"))).toBe(true);
    });

    it("returns false when code is a non-transient SQLSTATE", () => {
      expect(isTransientError(pgError("syntax error", "42601"))).toBe(false);
    });

    it("does not match SQLSTATE codes in message text (only checks .code)", () => {
      // A plain Error with "08006" in the message but no .code should NOT match the PG code path
      expect(isTransientError(new Error("error 08006 happened"))).toBe(false);
    });
  });

  describe("cause chain traversal", () => {
    it("detects transient error wrapped in DrizzleQueryError-style cause", () => {
      const inner = pgError("terminating connection", "57P01");
      const outer = wrappedError("Failed query: SELECT * FROM secret\nparams: []", inner);
      expect(isTransientError(outer)).toBe(true);
    });

    it("detects transient message error in cause chain", () => {
      const inner = new Error("Connection terminated unexpectedly");
      const outer = wrappedError("query failed", inner);
      expect(isTransientError(outer)).toBe(true);
    });

    it("returns false when cause chain has no transient errors", () => {
      const inner = pgError("unique_violation", "23505");
      const outer = wrappedError("Failed query: INSERT INTO ...", inner);
      expect(isTransientError(outer)).toBe(false);
    });
  });

  it("returns false for SQL syntax errors", () => {
    expect(isTransientError(new Error('syntax error at or near "SELEC"'))).toBe(false);
  });

  it("returns false for constraint violations", () => {
    expect(isTransientError(new Error("duplicate key value violates unique constraint"))).toBe(
      false,
    );
  });

  it("returns false for non-Error values", () => {
    expect(isTransientError("string error")).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });

  it("returns false for generic application errors", () => {
    expect(isTransientError(new Error("User not found"))).toBe(false);
  });
});
