// The WebSocket half of the integrations & secrets model, proven end to end
// against the deployed dummy-petshop (apps/dummy-petshop) — design §9 D6. A
// jailed secret worker holds an outbound WebSocket to a third party (petshop's
// gateway) with the SAME sealed access token injected THREE ways:
//
//   - "frame":       token sent inside an IDENTIFY frame (Discord shape — the
//                    worker read()s its own token and sends the bytes).
//   - "header":      token in the Authorization: Bearer UPGRADE header, as a
//                    getSecret(...) placeholder substituted at the jailed
//                    outbound (OpenAI-Realtime shape).
//   - "subprotocol": token in Sec-WebSocket-Protocol at the upgrade, likewise a
//                    substituted placeholder (browser-WS shape).
//
// What this proves that unit tests can't:
//   1. A jailed secret worker's outbound WS upgrade actually flows through
//      env.SECRET.fetch / globalOutbound and the Secret DO's WS-jail branch,
//      which dials the pinned upstream and relays frames.
//   2. For header/subprotocol, the credential placeholder in the UPGRADE headers
//      is substituted en route (headers only) — the worker never holds it.
//   3. petshop actually accepts the injected credential (a ready frame naming
//      the OAuth client) and echoes a subsequent frame.
//   4. The credential never appears in what crosses back to the caller.
//
// Requires a deployed OS (APP_CONFIG_BASE_URL) and a reachable dummy-petshop
// (PETSHOP_BASE_URL, or derived). See petshop-support.ts. Opt-in via
// PETSHOP_BASE_URL, exactly like integrations-petshop.e2e.test.ts, so the shared
// CI e2e lane (whose preview slot has no petshop) stays green.

import { describe, expect, test } from "vitest";
import { waitForCondition } from "../test-support/wait-for-condition.ts";
import { adminSecret, withItxSession } from "./test-helpers.ts";
import {
  PETSHOP_DEFAULT_CLIENT,
  PETSHOP_WS_SHAPE_HEADER,
  petshopAuthorize,
  petshopBaseUrl,
  petshopExchangeCode,
  petshopGatewayRelayWorkerRef,
  type PetshopWsShape,
} from "./petshop-support.ts";

const RUN = crypto.randomUUID().slice(0, 8);
const REDIRECT_URI = "https://example.com/callback";
const SHAPES: PetshopWsShape[] = ["frame", "header", "subprotocol"];

/** The JSON summary the gateway relay worker returns from a probe run: which
 * shape it drove, the terminal outcome ("echoed" on success), and every frame
 * petshop sent, in order. */
type ProbeResult = { shape: string; outcome: string; frames: Array<Record<string, any>> };

/**
 * Drive one WS credential shape end to end. Calling the OS egress door with a
 * getSecret(...) placeholder makes the Project DO route to the connection secret
 * (which hosts the gateway relay worker); the `x-relay-shape` header tells the
 * worker which shape to inject. The worker dials petshop's gateway through
 * env.SECRET.fetch, runs the handshake internally, and returns the observed
 * frames as JSON — so no live socket has to cross back to this Node client.
 */
async function driveShape(
  // The itx project stub is dynamically typed over RPC (as in the sibling spec).
  project: any,
  connectionPath: string,
  shape: PetshopWsShape,
): Promise<{ status: number; body: ProbeResult }> {
  const response = await project.egress.fetch(
    new Request(`${petshopBaseUrl()}/gateway`, {
      headers: {
        [PETSHOP_WS_SHAPE_HEADER]: shape,
        // Routing only: names the connection secret whose worker handles this.
        // The relay worker ignores this header and composes its own upgrade.
        authorization: `Bearer getSecret({ path: "${connectionPath}", field: "accessToken" })`,
      },
    }),
  );
  return { status: response.status, body: (await response.json()) as ProbeResult };
}

const readyFrame = (frames: Array<Record<string, any>>) => frames.find((f) => f?.op === "ready");

describe.skipIf(!process.env.PETSHOP_BASE_URL)(
  "dummy-petshop WebSocket gateway (three credential shapes)",
  () => {
    test("frame, header, and subprotocol shapes each inject the token; petshop accepts it", async () => {
      const petshop = petshopBaseUrl();
      const { clientId, clientSecret } = PETSHOP_DEFAULT_CLIENT;
      const connectionPath = `/secrets/integrations/petshop-ws-${RUN}/relay`;

      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({ slug: `petshop-ws-${RUN}` });
      await project.__describe();

      // Obtain a real petshop access token (seeded client), store it in a
      // connection secret pinned to petshop, and install the gateway relay
      // worker (the trust event). No app secret / refresh needed: the WS proof
      // is about presenting an existing token three ways.
      const code = await petshopAuthorize({ clientId, redirectUri: REDIRECT_URI });
      const tokens = await petshopExchangeCode({
        clientId,
        clientSecret,
        code,
        redirectUri: REDIRECT_URI,
      });

      using connectionSecret = project.secrets.get(connectionPath);
      await connectionSecret.update({
        egress: { urls: [petshop] },
        material: { accessToken: tokens.access_token },
        worker: petshopGatewayRelayWorkerRef({
          petshopOrigin: petshop,
          secretPath: connectionPath,
        }),
      });
      await waitForCondition(async () => (await connectionSecret.describe()).hasWorker, {
        description: "gateway relay worker to install",
      });

      for (const shape of SHAPES) {
        const { status, body } = await driveShape(project, connectionPath, shape);
        expect(status, `${shape}: HTTP status`).toBe(200);
        expect(body.shape, `${shape}: echoed shape`).toBe(shape);
        // petshop accepted the credential: a ready frame naming the OAuth client.
        const ready = readyFrame(body.frames ?? []);
        expect(ready, `${shape}: ready frame (petshop accepted the token)`).toBeTruthy();
        expect(ready!.user.clientId, `${shape}: client id`).toBe(clientId);
        // The full round trip completed: our probe frame was echoed back.
        expect(body.outcome, `${shape}: handshake outcome`).toBe("echoed");
        // Confinement: the token never appears in what came back to the caller.
        expect(JSON.stringify(body), `${shape}: no token leak in relay output`).not.toContain(
          tokens.access_token,
        );
      }

      // describe() never leaks the token either.
      expect(JSON.stringify(await connectionSecret.describe())).not.toContain(tokens.access_token);
    });

    // Negative: a connection whose stored token is bogus must be REJECTED by
    // petshop for every shape — proving petshop actually validates the injected
    // credential (not just that a socket opened). Its own connection, so it never
    // touches the positive token or petshop's global token epoch.
    test("a bogus access token is rejected by petshop across all shapes", async () => {
      const petshop = petshopBaseUrl();
      const connectionPath = `/secrets/integrations/petshop-ws-bad-${RUN}/relay`;

      using session = withItxSession();
      using itx = session.authenticate({ type: "admin-secret", secret: adminSecret() });
      using project = itx.projects.create({ slug: `petshop-ws-bad-${RUN}` });
      await project.__describe();

      using connectionSecret = project.secrets.get(connectionPath);
      await connectionSecret.update({
        egress: { urls: [petshop] },
        material: { accessToken: "not-a-real-sealed-token" },
        worker: petshopGatewayRelayWorkerRef({
          petshopOrigin: petshop,
          secretPath: connectionPath,
        }),
      });
      await waitForCondition(async () => (await connectionSecret.describe()).hasWorker, {
        description: "gateway relay worker (bad token) to install",
      });

      for (const shape of SHAPES) {
        const { body } = await driveShape(project, connectionPath, shape);
        expect(
          readyFrame(body.frames ?? []),
          `${shape}: no ready frame for a bad token`,
        ).toBeFalsy();
        // petshop sent {op:invalid} then close(4001); either can settle the probe.
        expect(["invalid", "closed:4001"], `${shape}: rejected outcome`).toContain(body.outcome);
      }
    });
  },
);
