// session-identity.e2e.test.ts — IDENTITY (src/principal.ts, session.ts, the DO's append root): a
// session authenticated with a project token knows who it is (`session.whoami()`), every event it
// appends carries `source.principal` — set by the DO, so a client's own `source.principal` is
// overwritten and an anonymous session's is stripped — the platform's own rows carry it too, a
// project the token does not name is refused, and a bad token is refused, both coded. A session with
// no token is the anonymous one intra-project code has always held.

import { expect, test } from "vitest";
import { codeOf, freshCtx, openItx, readAll, rejection, session } from "./support/client.ts";
import { mintProjectToken } from "./support/principal.ts";

test("a project token: whoami, source.principal on every append (unforgeable), the project bound, bad tokens refused", async () => {
  const projectId = freshCtx("identity");
  const principal = { actor: "user_ada", email: "ada@example.com" };
  const token = await mintProjectToken({ projectId, ...principal });
  const api = session();
  const authenticated = api.authenticate({ projectToken: token });
  expect(await authenticated.whoami()).toEqual({ projectId, ...principal });

  // every append the session makes carries the principal — the DO sets it, a client's own is overwritten
  const itx = authenticated.projects.get(projectId);
  await itx.append({ type: "note", payload: { n: 1 }, source: { principal: { actor: "forged" } } });
  await itx.provide("itx.demo", "itx.builtins.kv"); // the platform's own row, appended by the edge for this session
  // an anonymous session's client-supplied principal is stripped
  const anonymous = openItx(projectId);
  await anonymous.append({
    type: "note",
    payload: { n: 2 },
    source: { principal: { actor: "forged" } },
  });
  const events = await readAll(anonymous);
  const note1 = events.find((e) => e.type === "note" && e.payload?.n === 1);
  const rule = events.find((e) => e.type === "events.iterate.com/itx/rewrite-rule-configured");
  const note2 = events.find((e) => e.type === "note" && e.payload?.n === 2);
  expect(note1?.source?.principal).toEqual(principal);
  expect(rule?.source?.principal).toEqual(principal);
  expect(note2?.source?.principal).toBeUndefined();

  // the token names ONE project
  const other = await rejection(authenticated.projects.get(`${projectId}-other`).whoami());
  expect(codeOf(other), other.message).toBe("FORBIDDEN");
  // a bad token, an expired token: refused the same way
  const bad = await rejection(api.authenticate({ projectToken: `${token}x` }).whoami());
  expect(codeOf(bad), bad.message).toBe("INVALID_CREDENTIALS");
  const expired = await mintProjectToken({ projectId, ...principal, expiresAt: Date.now() - 1 });
  expect(codeOf(await rejection(api.authenticate({ projectToken: expired }).whoami()))).toBe(
    "INVALID_CREDENTIALS",
  );
  // no token: the anonymous session, as ever
  expect(await api.authenticate().whoami()).toBeNull();
});

test("the built-in cd carries the principal to a SIBLING context — an event appended through `itx.cd('/x').append(…)` is attributed like one appended at the root", async () => {
  const projectId = freshCtx("cd-who");
  const principal = { actor: "user_ada", email: "ada@example.com" };
  const itx = session()
    .authenticate({ projectToken: await mintProjectToken({ projectId, ...principal }) })
    .projects.get(projectId);
  await itx.invoke("itx.cd('/sibling').append({ type: 'note', payload: { via: 'cd' } })");
  const note = (await readAll(itx.cd("/sibling"))).find((e) => e.type === "note");
  expect(note?.source?.principal).toEqual(principal);
});
