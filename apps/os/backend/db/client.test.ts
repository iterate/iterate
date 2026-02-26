import { describe, it, expect } from "vitest";
import { isTransientError } from "./client.ts";

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
    expect(isTransientError(new Error("WebSocket was closed before the connection was established"))).toBe(true);
  });

  it("returns true for fetch failed errors", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  it("returns true for Postgres connection_failure (08006)", () => {
    expect(isTransientError(new Error("error code 08006: connection_failure"))).toBe(true);
  });

  it("returns true for Postgres admin_shutdown (57P01)", () => {
    expect(isTransientError(new Error("57P01: terminating connection due to administrator command"))).toBe(true);
  });

  it("returns true for Postgres too_many_connections (53300)", () => {
    expect(isTransientError(new Error("53300: too many connections"))).toBe(true);
  });

  it("returns false for SQL syntax errors", () => {
    expect(isTransientError(new Error('syntax error at or near "SELEC"'))).toBe(false);
  });

  it("returns false for constraint violations", () => {
    expect(isTransientError(new Error("duplicate key value violates unique constraint"))).toBe(false);
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
