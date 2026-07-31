// End-to-end proof of the control plane worker, run against local `wrangler dev` (http://localhost:8787).
// Proves: login→session; OAuth discovery (PRM + AS metadata); DCR client; authcode+PKCE-S256 with
// org+project CREATED AT /authorize; token; MCP whoami reflecting that project; and the API-key path.
import crypto from "node:crypto";

const BASE = process.env.BASE || "http://localhost:8787";
const USE_CIMD = BASE.startsWith("https"); // CIMD needs an HTTPS client_id; local http falls back to DCR
const REDIRECT = "http://localhost:8976/callback";
const RESOURCE = `${BASE}/mcp`;
const EMAIL = `alice+${Date.now()}@example.com`;
const SLUG = `proof-${Date.now().toString(36)}`;
let pass = 0,
  fail = 0;
const ok = (c, m) => {
  console.log(`${c ? "✅" : "❌"} ${m}`);
  c ? pass++ : fail++;
};
const b64url = (buf) => Buffer.from(buf).toString("base64url");

// 1. Login → session cookie
const loginRes = await fetch(`${BASE}/login`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ email: EMAIL, next: "/" }),
});
const cookie = (loginRes.headers.get("set-cookie") || "").split(";")[0];
ok(
  loginRes.status === 302 && cookie.startsWith("kernel_auth_session="),
  `login sets a session cookie (${loginRes.status})`,
);

// 2. OAuth discovery
const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
ok(
  Array.isArray(prm.authorization_servers) && prm.authorization_servers.length > 0,
  `PRM lists an authorization server (${prm.authorization_servers?.[0]})`,
);
const asMeta = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
ok(asMeta.code_challenge_methods_supported?.includes("S256"), "AS metadata advertises PKCE S256");
ok(asMeta.client_id_metadata_document_supported === true, "AS metadata advertises CIMD support");

// 3. Obtain a client_id. HTTPS → CIMD (client_id IS the metadata-doc URL, no registration). http → DCR.
let clientId;
if (USE_CIMD) {
  clientId = `${BASE}/cimd-test-client`;
  const doc = await (await fetch(clientId)).json();
  ok(
    doc.client_id === clientId && doc.redirect_uris?.includes(REDIRECT),
    `CIMD client_id is a self-describing URL (${clientId})`,
  );
} else {
  const reg = await (
    await fetch(`${BASE}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Proof MCP Client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json();
  clientId = reg.client_id;
  ok(!!clientId, `DCR registered a client (${clientId})`);
}

// 4. PKCE
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());

// 5. GET /authorize (with session) → consent page should offer to create a project
const authQuery = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  scope: "project",
  state: "xyz",
  resource: RESOURCE,
});
const consent = await (
  await fetch(`${BASE}/authorize?${authQuery}`, { headers: { cookie } })
).text();
ok(
  /create a new org \+ project/i.test(consent) && consent.includes("__new__"),
  "consent page offers to create an org+project",
);

// 6. POST /authorize (approve) creating org+project → capture the code
const approve = await fetch(`${BASE}/authorize?${authQuery}`, {
  method: "POST",
  redirect: "manual",
  headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ projectId: "__new__", orgName: "Proof Org", slug: SLUG }),
});
const loc = approve.headers.get("location") || "";
const code = new URL(loc).searchParams.get("code");
ok(
  approve.status === 302 && !!code && loc.startsWith(REDIRECT),
  `authorize returned an auth code (created project '${SLUG}')`,
);

// 7. Exchange code → access token
const tokRes = await fetch(`${BASE}/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: clientId,
    code_verifier: verifier,
    resource: RESOURCE,
  }),
});
const tok = await tokRes.json();
if (!tok.access_token) console.log("   token response:", tokRes.status, JSON.stringify(tok));
ok(!!tok.access_token, `token endpoint issued an access token (${tok.token_type || "?"})`);

// 8. Call /mcp with the token → whoami must reflect the just-created project
async function mcp(bearer, method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await r.text();
  // The MCP handler frames responses as SSE (event: message\ndata: {...}) when text/event-stream is
  // accepted. Extract the JSON from the data: line; fall back to plain JSON.
  const dataLine = body.split("\n").find((l) => l.startsWith("data:"));
  try {
    return JSON.parse(dataLine ? dataLine.slice(5).trim() : body);
  } catch {
    return { raw: body, status: r.status };
  }
}
await mcp(tok.access_token, "initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "proof", version: "0" },
});
const who = await mcp(tok.access_token, "tools/call", { name: "whoami", arguments: {} });
const whoText = who.result?.content?.[0]?.text ?? "";
let whoJson = {};
try {
  whoJson = JSON.parse(whoText);
} catch {}
ok(whoJson.email === EMAIL.toLowerCase(), `MCP whoami identifies the user (${whoJson.email})`);
ok(
  whoJson.projectId === SLUG,
  `MCP token is scoped to the org+project CREATED at /authorize (projectId=${whoJson.projectId})`,
);
const listed = await mcp(tok.access_token, "tools/call", { name: "list_projects", arguments: {} });
ok(
  (listed.result?.content?.[0]?.text ?? "").includes(SLUG),
  "MCP list_projects shows the new project",
);

// 9. API-key path: mint a key scoped to the project, use it as a bearer on /mcp
const keyPage = await (
  await fetch(`${BASE}/apikeys`, {
    method: "POST",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ projectId: SLUG, label: "cli" }),
  })
).text();
const rawKey = (keyPage.match(/<code>(key_[a-f0-9]+)<\/code>/) || [])[1];
ok(!!rawKey, `minted an API key (${rawKey?.slice(0, 12)}…)`);
const whoKey = await mcp(rawKey, "tools/call", { name: "whoami", arguments: {} });
let whoKeyJson = {};
try {
  whoKeyJson = JSON.parse(whoKey.result?.content?.[0]?.text ?? "");
} catch {}
ok(
  whoKeyJson.grants?.[0]?.projectId === SLUG,
  `API key authenticates /mcp with project grant (${whoKeyJson.grants?.[0]?.projectId})`,
);

console.log(`\n${fail === 0 ? "ALL PASS" : "SOME FAILED"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
