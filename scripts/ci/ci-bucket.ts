// scripts/ci/ci-bucket.ts — THE CI BUCKET (envs.ts `ciBucketEnvs.ci`, docs/test-evidence.md)
// through R2's S3 API (https://developers.cloudflare.com/r2/api/s3/api/): the test evidence upload
// (scripts/ci/test-evidence.ts) writes to it, and the flake dashboard (scripts/ci/flake-dashboard)
// reads it.
//
// The credentials are the Cloudflare API token CI already holds (Doppler `_shared/preview`'s
// CLOUDFLARE_API_TOKEN, the one preview deploys use): an API token with R2 permissions is also an
// S3 key pair, its id the access key id and the SHA-256 of its value the secret
// (https://developers.cloudflare.com/r2/api/tokens/#get-s3-api-credentials-from-an-api-token).
// Every request, the token's check included, is asked again when Cloudflare itself fails it
// (fetchRetryingPlatformFailures), each a read or a write-once PUT that a repeat cannot double.
// aws4fetch only signs: its own `AwsClient.fetch` would retry out of sight.
import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { fetchRetryingPlatformFailures } from "@iterate-com/shared/platform-retry";

/** The bucket's client, once the API token's id is known. */
export async function ciBucket(input: {
  accountId: string;
  bucketName: string;
  /** Doppler `_shared/preview`'s CLOUDFLARE_API_TOKEN. */
  apiToken: string;
  /** The caller's name in each retry's `<area>.platform-failure-retry` warn. */
  area: string;
  fetch?: typeof fetch;
  /** Each attempt's own bound (fetchRetryingPlatformFailures `timeoutMs`). */
  timeoutMs?: number;
  /** Aborts the request in flight and every retry after it. */
  signal?: AbortSignal;
  /** Called before each repeat of a request. */
  onRetry?: () => void;
}) {
  const fetchImpl = input.fetch || fetch;
  const send = (what: string, request: (signal: AbortSignal) => Promise<Response>) => {
    let sent = 0;
    return fetchRetryingPlatformFailures(
      what,
      (signal) => {
        if (sent++ > 0) input.onRetry?.();
        return request(signal);
      },
      { area: input.area, idempotent: true, timeoutMs: input.timeoutMs, signal: input.signal },
    );
  };
  const client = new AwsClient({
    accessKeyId: await apiTokenId(input, send, fetchImpl),
    secretAccessKey: createHash("sha256").update(input.apiToken).digest("hex"),
    service: "s3",
    region: "auto",
  });
  const origin = `https://${input.accountId}.r2.cloudflarestorage.com/${input.bucketName}`;
  const objectUrl = (key: string) =>
    `${origin}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const signed = (what: string, url: string, init: RequestInit = {}) =>
    send(what, async (signal) => fetchImpl(await client.sign(url, init), { signal }));
  const text = async (what: string, url: string) => {
    const response = await signed(what, url);
    if (response.ok) return response.text();
    throw new Error(`R2 ${what}: ${response.status} ${await response.text()}`);
  };
  return {
    /** A write-once PUT (`If-None-Match: *`) whose payload hash R2 checks: its answer, a 412 for a
     *  key that already exists included. */
    put: (key: string, body: Uint8Array, headers: { contentType: string; sha256: string }) =>
      signed(`PUT ${key}`, objectUrl(key), {
        method: "PUT",
        body,
        headers: {
          "content-type": headers.contentType,
          "if-none-match": "*",
          "x-amz-content-sha256": headers.sha256,
        },
      }),
    /** The object's headers, as R2 answers them. */
    head: (key: string) => signed(`HEAD ${key}`, objectUrl(key), { method: "HEAD" }),
    /** The object's text. */
    get: (key: string) => text(`GET ${key}`, objectUrl(key)),
    /** Every object under `prefix`: ListObjectsV2, a page of up to 1,000 keys at a time. */
    async list(prefix: string) {
      const objects: { key: string; lastModified: string }[] = [];
      let continuation: string | undefined;
      do {
        const url = new URL(origin);
        url.searchParams.set("list-type", "2");
        url.searchParams.set("prefix", prefix);
        if (continuation) url.searchParams.set("continuation-token", continuation);
        const page = await text(`LIST ${prefix}`, url.toString());
        for (const [, contents] of page.matchAll(/<Contents>(.*?)<\/Contents>/gsu)) {
          const key = /<Key>(.*?)<\/Key>/su.exec(contents!)?.[1];
          const lastModified = /<LastModified>(.*?)<\/LastModified>/su.exec(contents!)?.[1];
          if (key && lastModified) objects.push({ key: unescapeXml(key), lastModified });
        }
        const next = /<NextContinuationToken>(.*?)<\/NextContinuationToken>/su.exec(page)?.[1];
        continuation = next && unescapeXml(next);
      } while (continuation);
      return objects;
    },
  };
}

/**
 * The API token's id, which is its S3 access key id. A user token answers `/user/tokens/verify`,
 * an account-owned one its account's (https://developers.cloudflare.com/api/resources/user/subresources/tokens/methods/verify/).
 */
async function apiTokenId(
  input: { accountId: string; apiToken: string },
  send: (what: string, request: (signal: AbortSignal) => Promise<Response>) => Promise<Response>,
  fetchImpl: typeof fetch,
) {
  const answers: string[] = [];
  for (const path of ["/user/tokens/verify", `/accounts/${input.accountId}/tokens/verify`]) {
    const response = await send(`GET ${path}`, (signal) =>
      fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        headers: { authorization: `Bearer ${input.apiToken}` },
        signal,
      }),
    );
    if (response.ok) return TokenVerification.parse(await response.json()).result.id;
    await response.body?.cancel();
    answers.push(`${path}: ${response.status}`);
  }
  throw new Error(`CLOUDFLARE_API_TOKEN did not verify (${answers.join(", ")})`);
}

const TokenVerification = z.object({ result: z.object({ id: z.string().min(1) }) });

function unescapeXml(text: string) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}
