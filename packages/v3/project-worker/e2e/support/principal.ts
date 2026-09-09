// principal.ts — the credentials a test mints for the worker under test, each through the real door
// on the admin session: a PROJECT TOKEN through `projects.get(project).mintToken()`, a PROJECT API
// KEY through `.rotateApiKey()`. Nothing is signed locally, so a deployed run needs no secret but the
// admin's.
import { adminCredentials, session } from "./client.ts";

/** A project token for `project` — `projects.get(project).mintToken({ ttlSeconds })` as `as` (a
 *  member: `registerProject(project, as)` made them one — the token carries them) or, without, as
 *  the admin (`{ actor: "admin" }`). 15 minutes unless `ttlSeconds` says otherwise. */
export const mintProjectToken = (
  project: string,
  as?: { sub: string; email: string },
  ttlSeconds?: number,
): Promise<string> =>
  session()
    .authenticate(adminCredentials(as))
    .projects.get(project)
    .mintToken(ttlSeconds === undefined ? {} : { ttlSeconds });

/** The project's API key, minted fresh — `projects.get(project).rotateApiKey()` on the admin session
 *  (a previous key stops verifying). What a device presents: `authenticate({ type: "project-secret",
 *  project, secret })` over `/api`, or `Authorization: Bearer` on the project's host. */
export const mintProjectApiKey = (project: string): Promise<string> =>
  session().authenticate(adminCredentials()).projects.get(project).rotateApiKey();
