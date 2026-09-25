import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import { iterateAppIssuesToken } from "./update.ts";

test("the iterate app's token is asked for issues: write on this repository only", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await using github = gitHubApp();

  const token = await iterateAppIssuesToken({
    appId: "2001598",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    owner: "iterate",
    repo: "iterate",
  });

  expect(token).toEqual({
    token: "ghs_narrowed",
    permissions: { issues: "write", metadata: "read" },
    repositories: ["iterate"],
  });
  const [installation, access] = github.fetch.mock.calls as unknown as [
    string,
    { method: string; headers: Record<string, string>; body?: string },
  ][];
  expect(installation![0]).toBe("https://api.github.com/repos/iterate/iterate/installation");
  expect(access![0]).toBe("https://api.github.com/app/installations/42/access_tokens");
  expect(JSON.parse(access![1].body!)).toEqual({
    repositories: ["iterate"],
    permissions: { issues: "write" },
  });
  // The app JWT: RS256 over header.payload, issued by the app, verifiable with its public key.
  const [header, payload, signature] = access![1].headers.authorization!.slice(7).split(".");
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
    iss: "2001598",
  });
  expect(
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature!, "base64url"),
  ).toBe(true);
});

/** GitHub's App endpoints for the iterate app: its installation on this repo, and a narrowed token. */
function gitHubApp() {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("/installation")
      ? new Response(JSON.stringify({ id: 42 }))
      : new Response(
          JSON.stringify({
            token: "ghs_narrowed",
            permissions: { issues: "write", metadata: "read" },
            repositories: [{ name: "iterate" }],
          }),
          { status: 201 },
        ),
  );
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    async [Symbol.asyncDispose]() {
      vi.unstubAllGlobals();
    },
  };
}
