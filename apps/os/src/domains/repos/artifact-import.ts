/** Ask Cloudflare Artifacts to clone a public GitHub repository directly.
 * The deterministic target makes creation retry-safe: recovery after a
 * completed import but before `repo/ready` accepts that exact existing target
 * without ever cloning its contents into the Worker isolate. */
export async function importGithubArtifact(
  artifacts: Pick<Artifacts, "get" | "import">,
  input: { branch: string; depth: number; name: string; owner: string; repo: string },
  options: {
    fetchRemote?: typeof fetch;
    pollAttempts?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ commitOid: string }> {
  let artifact: ArtifactsRepo | undefined;
  try {
    await artifacts.import({
      source: {
        url: `https://github.com/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}.git`,
        branch: input.branch,
        depth: input.depth,
      },
      target: { name: input.name },
    });
    artifact = await artifacts.get(input.name);
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code !== "ALREADY_EXISTS" && code !== "IMPORT_IN_PROGRESS") throw error;

    const pollAttempts = options.pollAttempts ?? 60;
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < pollAttempts; attempt++) {
      try {
        artifact = await artifacts.get(input.name);
        break;
      } catch (getError) {
        if ((getError as { code?: unknown })?.code !== "IMPORT_IN_PROGRESS") throw getError;
      }
      if (attempt + 1 < pollAttempts) await sleep(pollIntervalMs);
    }
    if (artifact === undefined) {
      throw new Error(
        `Timed out waiting for Cloudflare Artifacts to import ${input.owner}/${input.repo} into "${input.name}".`,
      );
    }
  }
  return {
    commitOid: await artifactBranchHead(artifact, input.branch, options.fetchRemote ?? fetch),
  };
}

const ARTIFACT_REF_TOKEN_TTL_SECONDS = 60;
const MAX_REF_ADVERTISEMENT_BYTES = 1024 * 1024;

/** Read one advertised ref without downloading any Git objects. A short-lived
 * read token is always revoked, so importing a repo does not leave credentials
 * behind. */
async function artifactBranchHead(
  artifact: ArtifactsRepo,
  branch: string,
  fetchRemote: typeof fetch,
): Promise<string> {
  const token = await artifact.createToken("read", ARTIFACT_REF_TOKEN_TTL_SECONDS);
  let readError: unknown;
  let commitOid: string | undefined;
  try {
    commitOid = await remoteBranchHead({
      branch,
      fetchRemote,
      remote: artifact.remote,
      token: token.plaintext.split("?expires=")[0] ?? token.plaintext,
    });
  } catch (error) {
    readError = error;
  }

  let revokeError: unknown;
  try {
    if (!(await artifact.revokeToken(token.id))) {
      throw new Error(`Artifact read token ${token.id} disappeared before revocation.`);
    }
  } catch (error) {
    revokeError = error;
  }
  if (readError !== undefined && revokeError !== undefined) {
    throw new AggregateError(
      [readError, revokeError],
      `Failed to read ${branch} and revoke its temporary Artifact token.`,
    );
  }
  if (readError !== undefined) throw readError;
  if (revokeError !== undefined) throw revokeError;
  if (commitOid === undefined) throw new Error("Artifact branch head read returned no commit.");
  return commitOid;
}

async function remoteBranchHead(input: {
  branch: string;
  fetchRemote: typeof fetch;
  remote: string;
  token: string;
}): Promise<string> {
  const response = await input.fetchRemote(
    `${input.remote.replace(/\/$/, "")}/info/refs?service=git-upload-pack`,
    {
      headers: {
        accept: "application/x-git-upload-pack-advertisement",
        authorization: `Basic ${btoa(`x:${input.token}`)}`,
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Artifact ref advertisement failed with HTTP ${response.status}.`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_REF_ADVERTISEMENT_BYTES) {
    throw new Error(`Artifact ref advertisement exceeded ${MAX_REF_ADVERTISEMENT_BYTES} bytes.`);
  }
  const ref = `refs/heads/${input.branch}`;
  for (const packet of decodePacketLines(bytes)) {
    const advertised = packet.split("\0", 1)[0]!.trimEnd();
    const match = /^([0-9a-f]{40,64}) (.+)$/.exec(advertised);
    if (match?.[2] === ref) return match[1]!;
  }
  throw new Error(`Artifact did not advertise branch "${input.branch}" after import.`);
}

function decodePacketLines(bytes: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const packets: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; ) {
    if (offset + 4 > bytes.byteLength) throw new Error("Truncated Git packet-line length.");
    const lengthText = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/i.test(lengthText)) throw new Error("Invalid Git packet-line length.");
    const length = Number.parseInt(lengthText, 16);
    offset += 4;
    if (length === 0 || length === 1 || length === 2) continue;
    if (length < 4 || offset + length - 4 > bytes.byteLength) {
      throw new Error("Truncated Git packet-line payload.");
    }
    packets.push(decoder.decode(bytes.subarray(offset, offset + length - 4)));
    offset += length - 4;
  }
  return packets;
}
