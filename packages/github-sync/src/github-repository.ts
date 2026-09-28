// github-repository.ts — which GitHub repository a repo's origin names: the sync pulls only on a push
// to that repository, and the install finds the connection whose installation reaches it.

/** `owner/repo` of a GitHub origin (`https://[userinfo@]github.com/<owner>/<repo>[.git]`), or null
 *  for no origin or another host. The userinfo, which may hold a secret placeholder, is skipped. */
export function githubRepositoryOf(origin: string | null): string | null {
  const match = /^https:\/\/(?:.*@)?github\.com\/([^/@]+)\/([^/@]+?)(?:\.git)?\/?$/.exec(
    origin || "",
  );
  return match ? `${match[1]}/${match[2]}` : null;
}
