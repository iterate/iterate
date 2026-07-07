/**
 * Unit tests for the Discord-style gateway (GET /gateway). These drive the
 * protocol logic directly through `handleGatewayMessage` — the same function
 * the route handler wires to a real WebSocketPair — so the suite is fully
 * hermetic (no live socket, no network). The point being exercised is the
 * one the OS secret-worker model must support: the sealed access token rides
 * *inside* an IDENTIFY frame, and is validated exactly like the header-bearing
 * `accessGrant` path (unseal, t==="access", exp>now, epoch===current).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  AUTH_FAILED_CLOSE_CODE,
  bearerTokenFromHeader,
  GATEWAY_SUBPROTOCOL,
  type GatewayDeps,
  handleGatewayMessage,
  handleUpgradeAuth,
  HEARTBEAT_INTERVAL_MS,
  helloFrame,
  newGatewayConnection,
  SUBPROTOCOL_TOKEN_PREFIX,
  subprotocolAuth,
} from "./gateway.ts";
import { randomSealKey, seal } from "./seal.ts";

/** An access-token payload sealed under `key`, minted `epoch`/`ttl` however the test needs. */
async function sealedAccessToken(
  key: string,
  overrides: { sub?: string; clientId?: string; epoch?: number; exp?: number } = {},
): Promise<string> {
  return seal(
    {
      t: "access",
      sub: overrides.sub ?? "Jonas",
      clientId: overrides.clientId ?? "petshop-default",
      epoch: overrides.epoch ?? 0,
      exp: overrides.exp ?? Math.floor(Date.now() / 1000) + 120,
    },
    key,
  );
}

/** Parse the frames a reaction sends (they are always JSON text). */
const parse = (frames: string[]) => frames.map((frame) => JSON.parse(frame) as Record<string, any>);

afterEach(() => {
  vi.useRealTimers();
});

describe("gateway hello", () => {
  test("advertises the heartbeat interval on connect", () => {
    expect(JSON.parse(helloFrame())).toEqual({
      op: "hello",
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    });
  });
});

describe("gateway identify", () => {
  test("a valid access token → ready then a pet.created dispatch", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const state = newGatewayConnection();
    const token = await sealedAccessToken(key, { sub: "Jonas", clientId: "petshop-default" });

    const reaction = await handleGatewayMessage(
      state,
      JSON.stringify({ op: "identify", token }),
      deps,
    );
    expect(reaction.close).toBeUndefined();
    const [ready, dispatch] = parse(reaction.send);
    expect(ready).toEqual({ op: "ready", user: { sub: "Jonas", clientId: "petshop-default" } });
    expect(dispatch).toEqual({
      op: "dispatch",
      type: "pet.created",
      data: { id: "pet-3", name: "Rex", species: "terrier" },
    });
    expect(state.identified).toBe(true);
  });

  test("after ready, further frames are echoed back verbatim", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const state = newGatewayConnection();
    await handleGatewayMessage(
      state,
      JSON.stringify({ op: "identify", token: await sealedAccessToken(key) }),
      deps,
    );

    const echoed = await handleGatewayMessage(state, '{"op":"ping","n":1}', deps);
    expect(echoed.close).toBeUndefined();
    expect(parse(echoed.send)[0]).toEqual({ op: "echo", received: '{"op":"ping","n":1}' });
  });

  test("a missing token → invalid + close 4001", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const state = newGatewayConnection();
    const reaction = await handleGatewayMessage(state, JSON.stringify({ op: "identify" }), deps);
    expect(parse(reaction.send)[0].op).toBe("invalid");
    expect(reaction.close).toEqual({
      code: AUTH_FAILED_CLOSE_CODE,
      reason: "authentication failed",
    });
    expect(state.identified).toBe(false);
  });

  test("a garbage token → invalid + close 4001", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const reaction = await handleGatewayMessage(
      newGatewayConnection(),
      JSON.stringify({ op: "identify", token: "not-a-real-token" }),
      deps,
    );
    expect(parse(reaction.send)[0].op).toBe("invalid");
    expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  test("a token sealed under a different key → invalid + close 4001", async () => {
    const deps: GatewayDeps = { sealKey: randomSealKey(), getAccessTokenEpoch: async () => 0 };
    const foreign = await sealedAccessToken(randomSealKey());
    const reaction = await handleGatewayMessage(
      newGatewayConnection(),
      JSON.stringify({ op: "identify", token: foreign }),
      deps,
    );
    expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  test("an expired token → invalid + close 4001", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const token = await sealedAccessToken(key);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 121_000);
    const reaction = await handleGatewayMessage(
      newGatewayConnection(),
      JSON.stringify({ op: "identify", token }),
      deps,
    );
    expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  test("an epoch-revoked token → invalid + close 4001", async () => {
    const key = randomSealKey();
    // Token minted under epoch 0, but the shop has since bumped to epoch 1.
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 1 };
    const token = await sealedAccessToken(key, { epoch: 0 });
    const reaction = await handleGatewayMessage(
      newGatewayConnection(),
      JSON.stringify({ op: "identify", token }),
      deps,
    );
    expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  test("a non-identify first frame → invalid + close 4001", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const reaction = await handleGatewayMessage(
      newGatewayConnection(),
      JSON.stringify({ op: "heartbeat" }),
      deps,
    );
    expect(parse(reaction.send)[0].op).toBe("invalid");
    expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
  });

  test("a non-JSON first frame → invalid + close 4001", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const reaction = await handleGatewayMessage(newGatewayConnection(), "not json at all", deps);
    expect(parse(reaction.send)[0].op).toBe("invalid");
    expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
  });
});

describe("bearerTokenFromHeader (/gateway-header shape)", () => {
  test("extracts the bearer token, case-insensitively", () => {
    expect(bearerTokenFromHeader("Bearer abc.def")).toBe("abc.def");
    expect(bearerTokenFromHeader("bearer   xyz  ")).toBe("xyz");
  });

  test("null for absent or non-bearer headers", () => {
    expect(bearerTokenFromHeader(null)).toBeNull();
    expect(bearerTokenFromHeader("")).toBeNull();
    expect(bearerTokenFromHeader("Basic Zm9v")).toBeNull();
    expect(bearerTokenFromHeader("Bearer ")).toBeNull();
  });
});

describe("subprotocolAuth (/gateway-subprotocol shape)", () => {
  test("pulls the token from the carrier and selects a non-token protocol to echo", () => {
    const token = "sealed-token-value";
    const parsed = subprotocolAuth(`${GATEWAY_SUBPROTOCOL}, ${SUBPROTOCOL_TOKEN_PREFIX}${token}`);
    expect(parsed.token).toBe(token);
    // The echoed protocol is the real one, never the credential carrier.
    expect(parsed.selected).toBe(GATEWAY_SUBPROTOCOL);
  });

  test("carrier order does not matter and the token is never selected", () => {
    const token = "abc";
    const parsed = subprotocolAuth(`${SUBPROTOCOL_TOKEN_PREFIX}${token}, ${GATEWAY_SUBPROTOCOL}`);
    expect(parsed.token).toBe(token);
    expect(parsed.selected).toBe(GATEWAY_SUBPROTOCOL);
    expect(parsed.selected).not.toContain(token);
  });

  test("no carrier → null token; no header → null token and null selected", () => {
    expect(subprotocolAuth(GATEWAY_SUBPROTOCOL)).toEqual({
      token: null,
      selected: GATEWAY_SUBPROTOCOL,
    });
    expect(subprotocolAuth(null)).toEqual({ token: null, selected: null });
  });
});

describe("handleUpgradeAuth (header + subprotocol shapes)", () => {
  test("a valid token → identified, ready then a pet.created dispatch, no close", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };
    const token = await sealedAccessToken(key, { sub: "Jonas", clientId: "petshop-default" });

    const reaction = await handleUpgradeAuth(token, deps);
    expect(reaction.identified).toBe(true);
    expect(reaction.close).toBeUndefined();
    const [ready, dispatch] = parse(reaction.send);
    expect(ready).toEqual({ op: "ready", user: { sub: "Jonas", clientId: "petshop-default" } });
    expect(dispatch).toEqual({
      op: "dispatch",
      type: "pet.created",
      data: { id: "pet-3", name: "Rex", species: "terrier" },
    });
  });

  test("missing / garbage / foreign-key / expired / epoch-revoked → invalid + close 4001, not identified", async () => {
    const key = randomSealKey();
    const deps: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 0 };

    const expectRejected = (reaction: Awaited<ReturnType<typeof handleUpgradeAuth>>) => {
      expect(reaction.identified).toBe(false);
      expect(parse(reaction.send)[0].op).toBe("invalid");
      expect(reaction.close?.code).toBe(AUTH_FAILED_CLOSE_CODE);
    };

    expectRejected(await handleUpgradeAuth(null, deps));
    expectRejected(await handleUpgradeAuth("not-a-real-token", deps));
    expectRejected(await handleUpgradeAuth(await sealedAccessToken(randomSealKey()), deps));

    const epochRevoked: GatewayDeps = { sealKey: key, getAccessTokenEpoch: async () => 1 };
    expectRejected(
      await handleUpgradeAuth(await sealedAccessToken(key, { epoch: 0 }), epochRevoked),
    );

    const token = await sealedAccessToken(key);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 121_000);
    expectRejected(await handleUpgradeAuth(token, deps));
  });
});
