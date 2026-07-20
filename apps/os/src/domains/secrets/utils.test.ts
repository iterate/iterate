// Unit tests for the secret substitution grammar and compute helpers. Pure
// functions — no workerd, no DO. The Secret DO's fetch() drives these against
// real state and is exercised by the integration e2e proofs.

import { describe, expect, test } from "vitest";
import {
  computeHmacHex,
  computeSignatureBase64Url,
  normalizeSecretPath,
  secretReferencePathsFromRequest,
  secretReferencesFromHeaders,
  secretReferencesFromRequest,
  SecretSubstitutionError,
  selectSecretField,
  substituteSecretHeaders,
  substituteSecretRequest,
  timingSafeStringEqual,
} from "./utils.ts";

describe("normalizeSecretPath", () => {
  test("accepts canonical secret paths (bare name and sub-path)", () => {
    expect(normalizeSecretPath("/secrets/acme")).toBe("/secrets/acme");
    expect(normalizeSecretPath("secrets/acme")).toBe("/secrets/acme");
    expect(normalizeSecretPath("/secrets/github/app-1")).toBe("/secrets/github/app-1");
    expect(normalizeSecretPath("/secrets/oauth.token_v2")).toBe("/secrets/oauth.token_v2");
  });

  test("rejects paths outside /secrets/", () => {
    expect(() => normalizeSecretPath("/agents/victim")).toThrow(/must start with/);
  });

  // The path becomes a Durable Object name reparsed with WHATWG URL, which
  // collapses dot segments and splits on ?/# — so a path that survives here
  // but changes under URL parsing would address a different object than the
  // one displayed. These must all be rejected, not silently rewritten.
  test.each([
    "/secrets/../agents/victim",
    "/secrets/./x",
    "/secrets/x/../y",
    "/secrets/a?b",
    "/secrets/a#f",
    "/secrets/a%2e%2e/b",
    "/secrets/a b",
    "/secrets/a\\b",
    "/secrets/x/",
    "/secrets//y",
  ])("rejects non-canonical path %j", (path) => {
    expect(() => normalizeSecretPath(path)).toThrow();
  });
});

describe("selectSecretField", () => {
  test("no field returns whole material iff it is a string", () => {
    expect(selectSecretField("xoxb-token")).toBe("xoxb-token");
    expect(() => selectSecretField({ accessToken: "a" })).toThrow(SecretSubstitutionError);
  });

  test("dotted field walks structured material to a string", () => {
    const material = { tokens: { access: "at-1", refresh: "rt-1" } };
    expect(selectSecretField(material, "tokens.access")).toBe("at-1");
  });

  test("missing field or non-string leaf throws", () => {
    expect(() => selectSecretField({ a: 1 }, "a")).toThrow(SecretSubstitutionError);
    expect(() => selectSecretField({ a: "x" }, "b")).toThrow(SecretSubstitutionError);
  });
});

describe("secret reference parsing", () => {
  test("discovers exact references in an explicitly templated JSON body", async () => {
    const path = "/secrets/devices/phone/expo-push-token";
    const request = new Request("https://exp.host/--/api/v2/push/send", {
      body: JSON.stringify({
        nested: [{ token: `getSecret({ path: "${path}" })` }],
        explanation: `send getSecret({ path: "${path}" }) later`,
      }),
      headers: {
        "content-type": "application/json",
        "x-iterate-secret-template": "json",
      },
      method: "POST",
    });

    await expect(secretReferencesFromRequest(request)).resolves.toMatchObject({
      problems: [],
      references: [{ path }],
    });
    await expect(secretReferencePathsFromRequest(request)).resolves.toMatchObject({
      paths: [path],
      problems: [],
    });
  });

  test("parses path-only and path+field placeholders across headers", async () => {
    const headers = new Headers({
      authorization:
        'Basic getSecret({ path: "/secrets/integrations/petshop-home", field: "basicAuth" })',
      "x-token":
        'Bearer getSecret({ path: "/secrets/integrations/petshop-home/jonas", field: "tokens.access" })',
    });
    expect(secretReferencesFromHeaders(headers)).toEqual([
      { field: "basicAuth", path: "/secrets/integrations/petshop-home" },
      { field: "tokens.access", path: "/secrets/integrations/petshop-home/jonas" },
    ]);
    await expect(
      secretReferencePathsFromRequest(new Request("https://petshop.example/api", { headers })),
    ).resolves.toMatchObject({
      paths: ["/secrets/integrations/petshop-home", "/secrets/integrations/petshop-home/jonas"],
      problems: [],
    });
  });

  test("whole-material placeholder (no field key) parses", () => {
    const headers = new Headers({ authorization: 'Bearer getSecret({ path: "/secrets/openai" })' });
    expect(secretReferencesFromHeaders(headers)).toEqual([{ path: "/secrets/openai" }]);
  });

  // Telegram's Bot API authenticates in the URL PATH (`/bot<token>/<method>`;
  // there is no header auth), so the placeholder grammar reaches the request
  // URL too. The URL parser percent-encodes the placeholder's braces/spaces/
  // quotes when the Request is constructed; parsing must see through that.
  test("parses placeholders from the request URL (percent-encoded by Request construction)", async () => {
    const path = "/secrets/integrations/telegram/my-bot/bot-token";
    const request = new Request(
      `https://api.telegram.org/botgetSecret({ path: "${path}" })/sendMessage`,
      { method: "POST" },
    );
    expect(request.url).toContain("%7B"); // the parser really did encode it
    await expect(secretReferencesFromRequest(request)).resolves.toMatchObject({
      problems: [],
      references: [{ path }],
    });
    await expect(secretReferencePathsFromRequest(request)).resolves.toMatchObject({
      paths: [path],
      problems: [],
    });
  });

  test("URL and header placeholders addressing the same secret dedupe to one reference", async () => {
    const path = "/secrets/integrations/telegram/my-bot/bot-token";
    const request = new Request(
      `https://api.telegram.org/botgetSecret({ path: "${path}" })/getMe`,
      {
        headers: { "x-also": `getSecret({ path: "${path}" })` },
      },
    );
    await expect(secretReferencesFromRequest(request)).resolves.toMatchObject({
      problems: [],
      references: [{ path }],
    });
  });

  test("reports malformed opted-in JSON without throwing", async () => {
    const result = await secretReferencePathsFromRequest(
      new Request("https://api.example.com/messages", {
        body: "{not-json",
        headers: {
          "content-type": "application/json",
          "x-iterate-secret-template": "json",
        },
        method: "POST",
      }),
    );

    expect(result).toMatchObject({
      paths: [],
      problems: [{ code: "secret_json_template_invalid_body" }],
    });
  });
});

describe("substituteSecretHeaders", () => {
  test("replaces each placeholder with the resolved value", () => {
    const request = new Request("https://api.resend.com/emails", {
      headers: { authorization: 'Bearer getSecret({ path: "/secrets/resend", field: "apiKey" })' },
    });
    const substituted = substituteSecretHeaders(request, ({ path, field }) => {
      expect(path).toBe("/secrets/resend");
      expect(field).toBe("apiKey");
      return "re_live_123";
    });
    expect(substituted.headers.get("authorization")).toBe("Bearer re_live_123");
  });

  // A WS handshake IS an HTTP request, so upgrade headers substitute the same
  // way — the property the deferred WS-egress lane will rely on for the header
  // + subprotocol credential shapes. Substitution stays header-only; frames
  // are never touched.
  test("substitutes the Authorization and Sec-WebSocket-Protocol upgrade headers", () => {
    const path = "/secrets/integrations/petshop-home/jonas";
    const request = new Request("https://petshop.example/gateway-subprotocol", {
      headers: {
        upgrade: "websocket",
        authorization: `Bearer getSecret({ path: "${path}", field: "accessToken" })`,
        "sec-websocket-protocol": `petshop.v1, petshop.access-token.getSecret({ path: "${path}", field: "accessToken" })`,
      },
    });
    const substituted = substituteSecretHeaders(request, ({ path: p, field }) => {
      expect(p).toBe(path);
      expect(field).toBe("accessToken");
      return "sealed-access-token";
    });
    expect(substituted.headers.get("authorization")).toBe("Bearer sealed-access-token");
    // The real subprotocol survives verbatim; only the token carrier is filled.
    expect(substituted.headers.get("sec-websocket-protocol")).toBe(
      "petshop.v1, petshop.access-token.sealed-access-token",
    );
    // The upgrade intent is preserved through the header rewrite (a fresh
    // Request cloned from the original).
    expect(substituted.headers.get("upgrade")).toBe("websocket");
  });

  // GitHub git-over-HTTPS only accepts Basic (`x-access-token:<token>`), not
  // Bearer. Sandboxes plant the placeholder inside the base64 credential so
  // the container never holds token bytes; egress must peel, substitute, and
  // re-encode or git clone/push always 401s.
  test("substitutes a placeholder inside Basic Authorization base64", () => {
    const path = "/secrets/integrations/github/install-42";
    const placeholder = `getSecret({ path: "${path}", field: "accessToken" })`;
    const encoded = btoa(`x-access-token:${placeholder}`);
    const request = new Request(
      "https://github.com/acme/repo.git/info/refs?service=git-upload-pack",
      {
        headers: { authorization: `Basic ${encoded}` },
      },
    );
    expect(secretReferencesFromHeaders(request.headers)).toEqual([{ field: "accessToken", path }]);
    const substituted = substituteSecretHeaders(request, ({ path: p, field }) => {
      expect(p).toBe(path);
      expect(field).toBe("accessToken");
      return "ghs_install_token_abc";
    });
    expect(substituted.headers.get("authorization")).toBe(
      `Basic ${btoa("x-access-token:ghs_install_token_abc")}`,
    );
  });

  test("leaves non-placeholder Basic Authorization unchanged", () => {
    const encoded = btoa("user:already-real-token");
    const request = new Request("https://example.com", {
      headers: { authorization: `Basic ${encoded}` },
    });
    const substituted = substituteSecretHeaders(request, () => {
      throw new Error("resolver must not run");
    });
    expect(substituted.headers.get("authorization")).toBe(`Basic ${encoded}`);
  });
});

describe("substituteSecretRequest", () => {
  test("substitutes exact secret references in an explicitly templated JSON body", async () => {
    const path = "/secrets/devices/phone/expo-push-token";
    const request = new Request("https://exp.host/--/api/v2/push/send", {
      body: JSON.stringify({
        messages: [
          { to: `getSecret({ path: "${path}" })` },
          { to: `getSecret({ path: "${path}", field: "fallback" })` },
        ],
      }),
      headers: {
        "content-type": "application/json",
        "x-iterate-secret-template": "json",
      },
      method: "POST",
    });

    const substituted = await substituteSecretRequest(request, ({ field }) =>
      field === "fallback" ? "fallback-token" : "primary-token",
    );

    await expect(substituted.json()).resolves.toEqual({
      messages: [{ to: "primary-token" }, { to: "fallback-token" }],
    });
    expect(substituted.headers.has("x-iterate-secret-template")).toBe(false);
  });

  test("rejects JSON template mode without a JSON content type", async () => {
    const request = new Request("https://exp.host/--/api/v2/push/send", {
      body: '"getSecret({ path: \\"/secrets/device-token\\" })"',
      headers: {
        "content-type": "text/plain",
        "x-iterate-secret-template": "json",
      },
      method: "POST",
    });

    await expect(substituteSecretRequest(request, () => "token")).rejects.toMatchObject({
      code: "secret_json_template_invalid_content_type",
    });
  });

  test("rejects malformed opted-in JSON instead of forwarding it", async () => {
    const request = new Request("https://api.example.com/messages", {
      body: "{not-json",
      headers: {
        "content-type": "application/problem+json",
        "x-iterate-secret-template": "json",
      },
      method: "POST",
    });

    await expect(substituteSecretRequest(request, () => "token")).rejects.toMatchObject({
      code: "secret_json_template_invalid_body",
    });
  });

  test("rejects an oversized JSON template body", async () => {
    const request = new Request("https://api.example.com/messages", {
      body: JSON.stringify({ padding: "x".repeat(1_048_576) }),
      headers: {
        "content-type": "application/json",
        "x-iterate-secret-template": "json",
      },
      method: "POST",
    });

    await expect(substituteSecretRequest(request, () => "token")).rejects.toMatchObject({
      code: "secret_json_template_body_too_large",
    });
  });

  test("does not substitute embedded references or JSON object keys", async () => {
    const embedded = 'Bearer getSecret({ path: "/secrets/device-token" })';
    const key = 'getSecret({ path: "/secrets/device-token" })';
    const request = new Request("https://api.example.com/messages", {
      body: JSON.stringify({ [key]: "unchanged", embedded }),
      headers: {
        "content-type": "application/json",
        "x-iterate-secret-template": "json",
      },
      method: "POST",
    });

    const substituted = await substituteSecretRequest(request, () => {
      throw new Error("resolver must not run");
    });
    await expect(substituted.json()).resolves.toEqual({ [key]: "unchanged", embedded });
  });

  test("substitutes a URL-path placeholder (the Telegram /bot<token>/ shape) and keeps the body", async () => {
    const path = "/secrets/integrations/telegram/my-bot/bot-token";
    const request = new Request(
      `https://api.telegram.org/botgetSecret({ path: "${path}" })/sendMessage`,
      {
        body: JSON.stringify({ chat_id: 42, text: "hi" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
    );
    const substituted = await substituteSecretRequest(request, (reference) => {
      expect(reference).toEqual({ path });
      return "123456:AAH-abc_def";
    });
    expect(substituted.url).toBe("https://api.telegram.org/bot123456:AAH-abc_def/sendMessage");
    expect(substituted.method).toBe("POST");
    expect(await substituted.json()).toEqual({ chat_id: 42, text: "hi" });
  });

  test("substitutes headers and URL together from one resolver", async () => {
    const path = "/secrets/integrations/telegram/my-bot/bot-token";
    const request = new Request(
      `https://api.telegram.org/botgetSecret({ path: "${path}" })/getMe`,
      {
        headers: { "x-token": `getSecret({ path: "${path}" })` },
      },
    );
    const substituted = await substituteSecretRequest(request, () => "tok");
    expect(substituted.url).toBe("https://api.telegram.org/bottok/getMe");
    expect(substituted.headers.get("x-token")).toBe("tok");
  });

  test("a URL without placeholders stays byte-identical (no decode/re-encode round trip)", async () => {
    // %2Fusers is a legitimately percent-encoded path segment; substitution
    // must not decode it just because it scanned the URL for placeholders.
    const request = new Request("https://api.example.com/v1/files/a%2Fb?q=x%20y", {
      headers: { authorization: 'Bearer getSecret({ path: "/secrets/example" })' },
    });
    const substituted = await substituteSecretRequest(request, () => "tok");
    expect(substituted.url).toBe(request.url);
    expect(substituted.headers.get("authorization")).toBe("Bearer tok");
  });

  test("a path placeholder substitutes while innocent query params stay byte-identical", async () => {
    const path = "/secrets/integrations/telegram/my-bot/bot-token";
    const request = new Request(
      `https://api.telegram.org/botgetSecret({ path: "${path}" })/getUpdates?offset=42&q=x%20y`,
      { method: "POST" },
    );
    const substituted = await substituteSecretRequest(request, () => "123456:AAH-abc");
    expect(substituted.url).toBe(
      "https://api.telegram.org/bot123456:AAH-abc/getUpdates?offset=42&q=x%20y",
    );
  });

  // The URL ratchet: substitution covers the PATH only — exactly what
  // Telegram's /bot<token>/ shape needs. A placeholder in the query must fail
  // LOUDLY here; silently passing the literal placeholder through to the
  // provider would leak the reference string and answer as a confusing
  // provider-side 401.
  test("a placeholder in the query string throws instead of passing through", async () => {
    const request = new Request(
      'https://api.example.com/v1/lookup?token=getSecret({ path: "/secrets/example" })',
    );
    await expect(substituteSecretRequest(request, () => "tok")).rejects.toThrow(
      SecretSubstitutionError,
    );
    await expect(substituteSecretRequest(request, () => "tok")).rejects.toThrow(
      /secret_reference_outside_url_path.*query/,
    );
  });
});

describe("compute helpers", () => {
  test("computeHmacHex matches a known GitHub-style sha256 vector", async () => {
    // echo -n "hello world" | openssl dgst -sha256 -hmac "It's a Secret to Everybody"
    const digest = await computeHmacHex({
      key: "It's a Secret to Everybody",
      payload: "hello world",
    });
    expect(digest).toBe("cf0f2a031631d0d363407e4c4b717ff68cdedb238154f12cf2beeef298359fbd");
  });

  test("timingSafeStringEqual", () => {
    expect(timingSafeStringEqual("abc", "abc")).toBe(true);
    expect(timingSafeStringEqual("abc", "abd")).toBe(false);
    expect(timingSafeStringEqual("abc", "abcd")).toBe(false);
  });

  test("computeSignatureBase64Url produces an RS256 signature the public key verifies", async () => {
    // A real cryptographic round trip (not a golden string): generate an RSA
    // keypair, export the private key to PKCS#8 PEM (what a GitHub App secret
    // holds), sign an App-JWT-shaped payload, and verify with the public key.
    const keyPair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    let b64 = "";
    for (const byte of pkcs8) b64 += String.fromCharCode(byte);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;

    const payload = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhcHAtaWQifQ"; // header.payload
    const sig = await computeSignatureBase64Url({ privateKeyPem: pem, payload });

    expect(sig).not.toContain("=");
    expect(sig).not.toMatch(/[+/]/); // base64url, not base64
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      keyPair.publicKey,
      sigBytes as BufferSource,
      new TextEncoder().encode(payload) as BufferSource,
    );
    expect(ok).toBe(true);
  });
});
