import { expect, test } from "vitest";
import { parseAppConfigFromEnv } from "@iterate-com/shared/config";
import {
  channelStatusKey,
  handleChannelStatusRequest,
  handleInstallManifestRequest,
  handleInstallPageRequest,
  type StatusBucket,
} from "./channel-status.ts";
import { AppConfig } from "~/config.ts";

const ADMIN_SECRET = "channel-status-test-admin-secret";
const ORIGIN = "https://os.example.test";

const status = {
  channel: "my-feature",
  runtimeVersion: "37fb004ced1120b5d1fc8e57c7dd87e0aee98e8e",
  buildId: "build-1234",
  installUrl: "https://expo.dev/accounts/o/projects/p/builds/build-1234",
  buildFinished: true,
  commit: "abcdef1234567890",
  message: "PR #2555: fewer native builds",
  publishedAt: "2026-08-31T12:00:00.000Z",
};

test("PUT then GET round-trips a snapshot; GET is public with CORS", async () => {
  const bucket = fakeBucket();
  const put = await handleChannelStatusRequest({
    bucket,
    channel: "my-feature",
    config: config(),
    request: request("PUT", "my-feature", { body: status, admin: true }),
  });
  expect(put.status).toBe(200);
  expect(bucket.objects.get(channelStatusKey("my-feature"))).toContain(status.buildId);

  const get = await handleChannelStatusRequest({
    bucket,
    channel: "my-feature",
    config: config(),
    request: request("GET", "my-feature", {}),
  });
  expect(get.status).toBe(200);
  expect(get.headers.get("access-control-allow-origin")).toBe("*");
  expect(get.headers.get("cache-control")).toBe("no-store");
  expect(await get.json()).toMatchObject({ runtimeVersion: status.runtimeVersion });
});

test("writes require the admin bearer; reads do not", async () => {
  const bucket = fakeBucket();
  for (const auth of [undefined, "Bearer wrong-secret"]) {
    const put = await handleChannelStatusRequest({
      bucket,
      channel: "my-feature",
      config: config(),
      request: request("PUT", "my-feature", { body: status, authorization: auth }),
    });
    expect(put.status).toBe(401);
    const del = await handleChannelStatusRequest({
      bucket,
      channel: "my-feature",
      config: config(),
      request: request("DELETE", "my-feature", { authorization: auth }),
    });
    expect(del.status).toBe(401);
  }
  expect(bucket.objects.size).toBe(0);
});

test("PUT rejects malformed bodies and channel mismatches", async () => {
  const bucket = fakeBucket();
  const badShape = await handleChannelStatusRequest({
    bucket,
    channel: "my-feature",
    config: config(),
    request: request("PUT", "my-feature", { body: { channel: "my-feature" }, admin: true }),
  });
  expect(badShape.status).toBe(400);

  const mismatch = await handleChannelStatusRequest({
    bucket,
    channel: "other-channel",
    config: config(),
    request: request("PUT", "other-channel", { body: status, admin: true }),
  });
  expect(mismatch.status).toBe(400);
  expect(await mismatch.json()).toMatchObject({ error: expect.stringContaining("does not match") });
  expect(bucket.objects.size).toBe(0);
});

test("DELETE removes the snapshot and GET 404s afterwards", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(channelStatusKey("my-feature"), JSON.stringify(status));
  const del = await handleChannelStatusRequest({
    bucket,
    channel: "my-feature",
    config: config(),
    request: request("DELETE", "my-feature", { admin: true }),
  });
  expect(del.status).toBe(200);
  const get = await handleChannelStatusRequest({
    bucket,
    channel: "my-feature",
    config: config(),
    request: request("GET", "my-feature", {}),
  });
  expect(get.status).toBe(404);
});

test("an invalid channel name 404s before touching storage", async () => {
  const bucket = fakeBucket();
  const response = await handleChannelStatusRequest({
    bucket,
    channel: "Bad Channel!",
    config: config(),
    request: request("GET", "bad", {}),
  });
  expect(response.status).toBe(404);
});

test("the install page offers the snapshot's build and the open-in-app link, install first", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(channelStatusKey("my-feature"), JSON.stringify(status));
  const response = await handleInstallPageRequest({
    bucket,
    origin: ORIGIN,
    channel: "my-feature",
  });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain(status.installUrl);
  expect(html).toContain("Install this build");
  expect(html).toContain("iterate://preview-channel/my-feature");
  // Install comes before the open-in-app tap — a new binary's first boot
  // clears channel overrides, so switching first would be undone.
  expect(html.indexOf(status.installUrl)).toBeLessThan(html.indexOf("iterate://preview-channel"));
});

test("the install page for a still-compiling build says so instead of promising an install", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(
    channelStatusKey("my-feature"),
    JSON.stringify({ ...status, buildFinished: false }),
  );
  const response = await handleInstallPageRequest({
    bucket,
    origin: ORIGIN,
    channel: "my-feature",
  });
  const html = await response.text();
  expect(html).toContain("still compiling");
  expect(html).not.toContain("Install this build");
});

test("the install page without a snapshot falls back to the EAS builds list", async () => {
  const response = await handleInstallPageRequest({
    bucket: fakeBucket(),
    origin: ORIGIN,
    channel: "mystery",
  });
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain("https://expo.dev/accounts/mishanustom/projects/iterate/builds");
  expect(html).toContain("iterate://preview-channel/mystery");
});

test("snapshot text is HTML-escaped on the install page", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(
    channelStatusKey("my-feature"),
    JSON.stringify({ ...status, message: `<script>alert("x")</script>` }),
  );
  const response = await handleInstallPageRequest({
    bucket,
    origin: ORIGIN,
    channel: "my-feature",
  });
  const html = await response.text();
  expect(html).not.toContain("<script>alert");
  expect(html).toContain("&lt;script&gt;");
});

test("a fully-stocked snapshot makes the install page install in place (itms-services)", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(
    channelStatusKey("my-feature"),
    JSON.stringify({
      ...status,
      ipaUrl: "https://expo.dev/artifacts/eas/abc.ipa",
      appVersion: "0.1.0",
      bundleId: "com.iterate.mobile",
    }),
  );
  const response = await handleInstallPageRequest({
    bucket,
    origin: ORIGIN,
    channel: "my-feature",
  });
  const html = await response.text();
  expect(html).toContain(
    `itms-services://?action=download-manifest&amp;url=${encodeURIComponent(
      `${ORIGIN}/m/install-manifest/my-feature`,
    )}`,
  );
  // The expo.dev build page demotes to a details link, but stays reachable.
  expect(html).toContain("Build details");
  expect(html).toContain(status.installUrl);
});

test("an itms-less snapshot (pre-field, or build unfinished) keeps the build-page CTA", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(channelStatusKey("my-feature"), JSON.stringify(status));
  const withoutFields = await handleInstallPageRequest({
    bucket,
    origin: ORIGIN,
    channel: "my-feature",
  });
  expect(await withoutFields.text()).not.toContain("itms-services");

  bucket.objects.set(
    channelStatusKey("my-feature"),
    JSON.stringify({
      ...status,
      buildFinished: false,
      ipaUrl: "https://expo.dev/artifacts/eas/abc.ipa",
      appVersion: "0.1.0",
      bundleId: "com.iterate.mobile",
    }),
  );
  const unfinished = await handleInstallPageRequest({
    bucket,
    origin: ORIGIN,
    channel: "my-feature",
  });
  expect(await unfinished.text()).not.toContain("itms-services");
});

test("the manifest plist names the app and its ipa, XML-escaped", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(
    channelStatusKey("my-feature"),
    JSON.stringify({
      ...status,
      ipaUrl: "https://expo.dev/artifacts/eas/abc.ipa?a=1&b=2",
      appVersion: "0.1.0",
      bundleId: "com.iterate.mobile",
    }),
  );
  const response = await handleInstallManifestRequest({ bucket, channel: "my-feature" });
  const xml = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/xml");
  expect(xml).toContain("<string>https://expo.dev/artifacts/eas/abc.ipa?a=1&amp;b=2</string>");
  expect(xml).toContain("<string>com.iterate.mobile</string>");
  expect(xml).toContain("<string>0.1.0</string>");
  expect(xml).toContain("<string>software-package</string>");
});

test("the manifest 404s without the itms fields or without a snapshot", async () => {
  const bucket = fakeBucket();
  bucket.objects.set(channelStatusKey("my-feature"), JSON.stringify(status));
  const preItms = await handleInstallManifestRequest({ bucket, channel: "my-feature" });
  expect(preItms.status).toBe(404);
  const missing = await handleInstallManifestRequest({ bucket: fakeBucket(), channel: "ghost" });
  expect(missing.status).toBe(404);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function config(secret = ADMIN_SECRET) {
  return parseAppConfigFromEnv({
    configSchema: AppConfig,
    env: {
      APP_CONFIG: JSON.stringify({ openAiApiKey: "test-openai-key" }),
      APP_CONFIG_ADMIN_API_SECRET: secret,
    },
    prefix: "APP_CONFIG_",
  });
}

function request(
  method: string,
  channel: string,
  options: { admin?: boolean; authorization?: string; body?: unknown },
) {
  return new Request(`https://os.example.test/m/channel-status/${channel}`, {
    method,
    headers: {
      ...(options.admin && { authorization: `Bearer ${ADMIN_SECRET}` }),
      ...(options.authorization && { authorization: options.authorization }),
      ...(options.body !== undefined && { "content-type": "application/json" }),
    },
    ...(options.body !== undefined && { body: JSON.stringify(options.body) }),
  });
}

function fakeBucket(): StatusBucket & { objects: Map<string, string> } {
  const objects = new Map<string, string>();
  return {
    objects,
    get: async (key) => {
      const value = objects.get(key);
      return value === undefined ? null : { text: async () => value };
    },
    put: async (key, value) => {
      objects.set(key, value as string);
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
}
