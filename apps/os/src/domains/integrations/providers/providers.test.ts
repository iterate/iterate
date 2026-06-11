// The symmetry contract, exercised: every provider is a partial fetch
// function at ingress and an SDK factory at egress, and the two providers
// rhyme.

import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "./verify.ts";
import { githubIntegration } from "./github.ts";
import { discordIntegration, discordGatewayRoutingKey } from "./discord.ts";
import type { CaptureIntegrationEvent } from "~/domains/integrations/definition.ts";
import { replayPathCall } from "~/itx/path-proxy.ts";
import { INTEGRATIONS } from "~/domains/integrations/registry.ts";

describe("integration registry", () => {
  it("every integration rhymes: slug key, ingress fetch, provided secrets, sdk factory", () => {
    for (const [slug, definition] of Object.entries(INTEGRATIONS)) {
      expect(definition.slug).toBe(slug);
      expect(typeof definition.fetch).toBe("function");
      expect(definition.providedSecrets.length).toBeGreaterThan(0);
      expect(typeof definition.createSdk).toBe("function");
    }
  });
});

describe("github ingress (partial fetch function)", () => {
  it("ignores requests that are not its webhook", async () => {
    const { capture } = recordingCapture();
    const response = await githubIntegration.fetch!({
      request: new Request("https://os.iterate.com/api/anything-else"),
      env: { GITHUB_WEBHOOK_SECRET: "shh" },
      capture,
    });
    expect(response).toBeNull();
  });

  it("verifies the signature, captures by installation, and acks", async () => {
    const bodyText = JSON.stringify({ action: "opened", installation: { id: 1234 } });
    const signature = `sha256=${await hmacSha256Hex({ secret: "shh", message: bodyText })}`;
    const { capture, captured } = recordingCapture();

    const response = await githubIntegration.fetch!({
      request: new Request("https://os.iterate.com/api/integrations/github/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": signature, "x-github-delivery": "delivery-1" },
        body: bodyText,
      }),
      env: { GITHUB_WEBHOOK_SECRET: "shh" },
      capture,
    });

    expect(response?.status).toBe(200);
    expect(captured).toEqual([
      {
        transport: "webhook",
        routingKey: "installation:1234",
        idempotencyKey: "delivery-1",
        body: { action: "opened", installation: { id: 1234 } },
      },
    ]);
  });

  it("rejects bad signatures without capturing", async () => {
    const { capture, captured } = recordingCapture();
    const response = await githubIntegration.fetch!({
      request: new Request("https://os.iterate.com/api/integrations/github/webhook", {
        method: "POST",
        headers: { "x-hub-signature-256": "sha256=ffff" },
        body: "{}",
      }),
      env: { GITHUB_WEBHOOK_SECRET: "shh" },
      capture,
    });
    expect(response?.status).toBe(401);
    expect(captured).toEqual([]);
  });
});

describe("discord ingress", () => {
  it("answers PING with PONG and captures signed interactions by guild", async () => {
    const { publicKeyHex, sign } = await ed25519Keypair();
    const { capture, captured } = recordingCapture();

    const ping = JSON.stringify({ type: 1 });
    const pingResponse = await discordIntegration.fetch!({
      request: await signedDiscordRequest({ bodyText: ping, sign }),
      env: { DISCORD_PUBLIC_KEY: publicKeyHex },
      capture,
    });
    expect(await pingResponse?.json()).toEqual({ type: 1 });

    const interaction = JSON.stringify({ type: 2, id: "inter-1", guild_id: "42" });
    const response = await discordIntegration.fetch!({
      request: await signedDiscordRequest({ bodyText: interaction, sign }),
      env: { DISCORD_PUBLIC_KEY: publicKeyHex },
      capture,
    });
    expect(response?.status).toBe(200);
    expect(captured).toEqual([
      {
        transport: "webhook",
        routingKey: "guild:42",
        idempotencyKey: "interaction:inter-1",
        body: { type: 2, id: "inter-1", guild_id: "42" },
      },
    ]);
  });

  it("keys gateway frames the same way the webhook path does", () => {
    expect(
      discordGatewayRoutingKey({ op: 0, t: "MESSAGE_CREATE", s: 7, d: { guild_id: "42" } }),
    ).toBe("guild:42");
    expect(discordGatewayRoutingKey({ op: 0, t: "READY", d: {} })).toBeNull();
  });
});

describe("sdk factories (itx.integrations.{slug}.**)", () => {
  it("github builds an octokit whose nested REST methods are path-reachable", async () => {
    const requestedSecrets: string[] = [];
    const sdk = await githubIntegration.createSdk({
      projectId: "proj-a",
      getSecretMaterial: async (slug) => {
        requestedSecrets.push(slug);
        return "ghp_test";
      },
    });
    expect(requestedSecrets).toEqual(["github/access-token"]);
    // The exact path itx.integrations.github.octokit.rest.issues.create takes.
    const create = (sdk as { octokit: { rest: { issues: { create: unknown } } } }).octokit.rest
      .issues.create;
    expect(typeof create).toBe("function");
  });

  it("discord builds the @discordjs/core API with the bot token", async () => {
    const requestedSecrets: string[] = [];
    const sdk = (await discordIntegration.createSdk({
      projectId: "proj-a",
      getSecretMaterial: async (slug) => {
        requestedSecrets.push(slug);
        return "bot-token";
      },
    })) as { api: { channels: { createMessage: unknown } }; rest: unknown };
    expect(requestedSecrets).toEqual(["discord/bot-token"]);
    expect(typeof sdk.api.channels.createMessage).toBe("function");
  });

  it("replayPathCall walks an sdk exactly like the itx kernel will", async () => {
    const calls: unknown[] = [];
    const sdk = {
      octokit: { rest: { issues: { create: async (input: unknown) => calls.push(input) } } },
    };
    await replayPathCall(sdk, {
      path: ["octokit", "rest", "issues", "create"],
      args: [{ owner: "iterate", repo: "iterate", title: "hi" }],
    });
    expect(calls).toEqual([{ owner: "iterate", repo: "iterate", title: "hi" }]);
  });
});

function recordingCapture() {
  const captured: unknown[] = [];
  const capture: CaptureIntegrationEvent = async (event) => {
    captured.push(event);
  };
  return { capture, captured };
}

async function ed25519Keypair() {
  const keypair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keypair.publicKey));
  const publicKeyHex = Array.from(publicKeyRaw, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  const sign = async (message: string) => {
    const signature = new Uint8Array(
      await crypto.subtle.sign("Ed25519", keypair.privateKey, new TextEncoder().encode(message)),
    );
    return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  return { publicKeyHex, sign };
}

async function signedDiscordRequest(input: {
  bodyText: string;
  sign(message: string): Promise<string>;
}) {
  const timestamp = "1770000000";
  return new Request("https://os.iterate.com/api/integrations/discord/webhook", {
    method: "POST",
    headers: {
      "x-signature-ed25519": await input.sign(`${timestamp}${input.bodyText}`),
      "x-signature-timestamp": timestamp,
    },
    body: input.bodyText,
  });
}
