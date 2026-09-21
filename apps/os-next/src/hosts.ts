/** A CUSTOM HOSTNAME — one of the deployment's own that IS a project's apex
 *  (`urls.temporaryCustomHostnames`, `{ "iterate2.com": "iterate" }`): the apex shape, `app: null`, so
 *  the project's config worker `fetch` answers exactly as it does on `<project>.<hostname>`. Null for
 *  a hostname the map does not name. Pure. (The project-host grammar itself — subdomains, paths —
 *  lives in the SDK, `iterate/next/project-ingress`, so the platform, the dash and an app compose
 *  and parse the same URLs.) */
export function customProjectHostOf(
  hostname: string,
  hostnames: Record<string, string>,
): { app: null; project: string } | null {
  const project = hostnames[hostname.toLowerCase().replace(/\.$/, "")];
  return project ? { app: null, project } : null;
}
