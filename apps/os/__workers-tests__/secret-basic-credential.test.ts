// __workers-tests__/secret-basic-credential.test.ts — A PLACEHOLDER INSIDE A BASIC CREDENTIAL, the
// Authorization a git remote's userinfo becomes (`https://x:getSecret("/secrets/git")@git.test/…`,
// git-wire.ts `gitRemoteOf`), keeps every guarantee a header placeholder has: it is substituted only
// for an origin the secret is pinned to (a 502 to the caller otherwise, with nothing sent), the value
// is never echoed into the refusal, the `secret/used` fact or a log line, and a Basic credential with
// no placeholder in it passes through byte for byte.
//
// THE UPSTREAM IS IN-PROCESS: the secret facet's terminal `fetch` is the isolate's global fetch,
// answered below for every `.test` origin, each request recorded as the upstream saw it.
import { expect, test, vi } from "vitest";
import type { StreamEvent } from "iterate/stream/processor";
import { DurableObjectNameCodec } from "../src/context/paths.ts";
import { projectWithMember, stub } from "./support.ts";

test("a Basic credential's placeholder is substituted for the pinned origin only, never echoed; one with no placeholder passes as it is", async () => {
  const run = crypto.randomUUID().slice(0, 8);
  const token = `ghs_${crypto.randomUUID()}`;
  const project = await projectWithMember(`basic-${run}`);
  await project.itx.secrets.set("/secrets/git", token, { urls: ["https://git.test"] });
  const upstream = serveTestOrigins();
  const logged = captureLogs();
  const credential = basic('x-access-token:getSecret("/secrets/git")');
  const call = async (url: string, authorization: string) => {
    const response: Response = await project.itx.fetch(
      new Request(url, { method: "POST", headers: { authorization }, body: "0000" }),
    );
    return { status: response.status, body: await response.text() };
  };

  expect(await call("https://git.test/acme/config.git/git-upload-pack", credential)).toEqual({
    status: 200,
    body: "ok",
  });
  expect(upstream).toMatchObject({
    requests: [
      {
        url: "https://git.test/acme/config.git/git-upload-pack",
        authorization: basic(`x-access-token:${token}`),
      },
    ],
  });

  const refused = await call("https://elsewhere.test/acme/config.git/git-upload-pack", credential);
  expect(refused).toMatchObject({
    status: 502,
    body: expect.stringContaining("is pinned to https://git.test"),
  });
  expect(upstream.requests).toHaveLength(1); // nothing was sent to the unpinned origin

  const plain = basic("user:pass");
  expect(await call("https://plain.test/repo.git/git-upload-pack", plain)).toMatchObject({
    status: 200,
  });
  expect(upstream.requests.at(-1)).toEqual({
    url: "https://plain.test/repo.git/git-upload-pack",
    authorization: plain,
  });

  const used = await secretEvents(project.projectId);
  expect(used.filter((event) => event.type === "events.iterate.com/secret/used")).not.toEqual([]);
  for (const text of [refused.body, JSON.stringify(used), ...logged.lines])
    expect(text).not.toContain(token);
});

/** `user:password` as a Basic header value, UTF-8 first. */
function basic(credential: string): string {
  return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(credential)))}`;
}

/** Every `.test` origin answers `ok` for the rest of the test, each request recorded; anything else
 *  goes to the network. */
function serveTestOrigins() {
  const requests: { url: string; authorization: string | null }[] = [];
  const network = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (!new URL(request.url).hostname.endsWith(".test")) return network(request);
    requests.push({ url: request.url, authorization: request.headers.get("authorization") });
    return new Response("ok");
  });
  return { requests };
}

/** Every console line this isolate writes for the rest of the test. */
function captureLogs() {
  const lines: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method];
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
      original(...args);
    });
  }
  return { lines };
}

/** The events on the project's `/secrets/git` log. */
async function secretEvents(projectId: string): Promise<StreamEvent[]> {
  const name = DurableObjectNameCodec.stringify({ projectId, path: "/secrets/git" });
  const { events } = (await stub(name).invoke(["itx", ["readEvents", 0, 500]])) as {
    events: StreamEvent[];
  };
  return events;
}
