import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

type AssetFile = {
  hash: string;
  name: string;
  path: string;
  size: number;
  type: string;
};

class CloudflareHttpError extends Error {
  readonly status: number;

  constructor(input: { body: string; status: number; statusText: string }) {
    super(
      `Cloudflare asset upload failed (${String(input.status)}): ${input.body || input.statusText}`,
    );
    this.status = input.status;
  }
}

const args = parseArgs(process.argv.slice(2));

await preuploadWorkerAssets({
  assetsPath: args.assetsPath,
  workerName: args.workerName,
});

/**
 * Sequentially pre-uploads Worker static assets to Cloudflare.
 *
 * This intentionally mirrors Cloudflare's direct-upload protocol instead of
 * calling Alchemy internals. It is a deploy-time guard for the race described
 * in `iterate-app.ts`: after this finishes, Alchemy's own asset upload session
 * has no remaining file buckets and can safely attach the completion token to
 * the Worker metadata.
 *
 * First-party protocol reference:
 * https://developers.cloudflare.com/workers/static-assets/direct-upload/
 */
async function preuploadWorkerAssets(input: { assetsPath: string; workerName: string }) {
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const apiToken = requireEnv("CLOUDFLARE_API_TOKEN");
  const assetsPath = path.resolve(input.assetsPath);
  const files = await readAssets(assetsPath);
  const filesByHash = new Map(files.map((file) => [file.hash, file]));
  const manifest = Object.fromEntries(
    files.map((file) => [file.name, { hash: file.hash, size: file.size }]),
  );

  const apiBaseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  let uploadSession = await createAssetsUploadSession({
    apiBaseUrl,
    apiToken,
    manifest,
    workerName: input.workerName,
  });
  if (uploadSession instanceof CloudflareHttpError && uploadSession.status === 401) {
    await ensureWorkerShell({ apiBaseUrl, apiToken, workerName: input.workerName });
    uploadSession = await createAssetsUploadSession({
      apiBaseUrl,
      apiToken,
      manifest,
      workerName: input.workerName,
    });
  }
  if (uploadSession instanceof CloudflareHttpError) {
    throw uploadSession;
  }

  let completionToken = uploadSession.jwt;
  for (const bucket of uploadSession.buckets) {
    const formData = new FormData();
    for (const hash of bucket) {
      const file = filesByHash.get(hash);
      if (!file) throw new Error(`Cloudflare requested unknown asset hash ${hash}`);

      const content = await readFile(file.path);
      formData.append(hash, new Blob([content.toString("base64")], { type: file.type }), hash);
    }

    const uploadResult = await cloudflareJson<{ jwt?: string }>({
      apiToken: completionToken,
      body: formData,
      method: "POST",
      url: `${apiBaseUrl}/workers/assets/upload?base64=true`,
    });
    completionToken = uploadResult.jwt ?? completionToken;
  }

  if (!completionToken) {
    throw new Error(`Cloudflare did not return an asset completion token for ${input.workerName}`);
  }

  console.log(
    `[preupload-worker-assets] ${input.workerName}: ${String(files.length)} files, ${String(uploadSession.buckets.length)} buckets`,
  );
}

async function createAssetsUploadSession(input: {
  apiBaseUrl: string;
  apiToken: string;
  manifest: Record<string, { hash: string; size: number }>;
  workerName: string;
}) {
  try {
    return await cloudflareJson<{
      buckets: string[][];
      jwt: string;
    }>({
      apiToken: input.apiToken,
      body: { manifest: input.manifest },
      method: "POST",
      url: `${input.apiBaseUrl}/workers/scripts/${input.workerName}/assets-upload-session`,
    });
  } catch (error) {
    if (error instanceof CloudflareHttpError) return error;
    throw error;
  }
}

/**
 * Creates a throwaway module Worker so Cloudflare will open an assets upload
 * session for a freshly recycled preview script name. Alchemy immediately
 * replaces this shell with the real bundled Worker in the next resource step.
 *
 * First-party upload endpoint reference:
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/
 */
async function ensureWorkerShell(input: {
  apiBaseUrl: string;
  apiToken: string;
  workerName: string;
}) {
  const formData = new FormData();
  formData.append(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          compatibility_date: "2026-04-24",
          main_module: "worker.js",
        }),
      ],
      { type: "application/json" },
    ),
  );
  formData.append(
    "worker.js",
    new Blob(
      [
        "export default { fetch() { return new Response('OS preview worker shell', { status: 503 }); } };",
      ],
      { type: "application/javascript+module" },
    ),
    "worker.js",
  );

  await cloudflareJson<unknown>({
    apiToken: input.apiToken,
    body: formData,
    method: "PUT",
    url: `${input.apiBaseUrl}/workers/scripts/${input.workerName}`,
  });
}

async function readAssets(root: string): Promise<AssetFile[]> {
  const ignoredNames = new Set([".assetsignore", "_headers", "_redirects"]);
  const files: AssetFile[] = [];

  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (ignoredNames.has(entry.name)) continue;

      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }

      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile()) continue;

      files.push({
        hash: await computeCloudflareAssetHash(absolutePath),
        name: `/${path.relative(root, absolutePath)}`,
        path: absolutePath,
        size: fileStat.size,
        type: contentTypeForPath(absolutePath),
      });
    }
  }

  await visit(root);
  return files;
}

async function computeCloudflareAssetHash(filePath: string) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  hash.update(path.extname(filePath).slice(1));
  hash.update(contentTypeForPath(filePath));
  return hash.digest("hex").slice(0, 32);
}

async function cloudflareJson<T>(input: {
  apiToken: string;
  body: FormData | object;
  method: "POST" | "PUT";
  url: string;
}): Promise<T> {
  const response = await fetch(input.url, {
    method: input.method,
    headers:
      input.body instanceof FormData
        ? { Authorization: `Bearer ${input.apiToken}` }
        : {
            Authorization: `Bearer ${input.apiToken}`,
            "Content-Type": "application/json",
          },
    body: input.body instanceof FormData ? input.body : JSON.stringify(input.body),
  });

  const text = await response.text();
  let payload: {
    errors?: Array<{ code: number; message: string }>;
    result?: T;
  };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new CloudflareHttpError({
      body: text,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (!response.ok || !payload.result) {
    const errors = payload.errors?.map((error) => `${error.code}: ${error.message}`).join("; ");
    throw new CloudflareHttpError({
      body: errors || response.statusText,
      status: response.status,
      statusText: response.statusText,
    });
  }

  return payload.result;
}

function contentTypeForPath(filePath: string) {
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".html")) return "text/html";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".json") || filePath.endsWith(".map")) return "application/json";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function parseArgs(argv: string[]) {
  const workerName = readFlag(argv, "--worker-name");
  const assetsPath = readFlag(argv, "--assets");
  return { assetsPath, workerName };
}

function readFlag(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value) throw new Error(`Missing required ${flag} argument`);
  return value;
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
