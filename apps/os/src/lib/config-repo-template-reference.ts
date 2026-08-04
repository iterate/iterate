type ConfigRepoTemplateReference = {
  owner: string;
  path?: string;
  ref?: string;
  repo: string;
};

const GITHUB_OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** The path invariant shared by the string parser, RPC schema, and clone
 * adapter. It prevents a selected subtree from escaping into clone metadata. */
export function isSafeConfigRepoTemplatePath(path: string): boolean {
  const segments = path.split("/");
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.endsWith("/") &&
    !path.includes("\\") &&
    !path.includes("&") &&
    !Array.from(path).some((character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 31 || codePoint === 127;
    }) &&
    !segments.some(
      (segment) =>
        segment === "" || segment === "." || segment === ".." || segment.toLowerCase() === ".git",
    )
  );
}

/**
 * Parse the public-GitHub subset of pnpm's Git dependency syntax. The result
 * is provider-neutral data safe to place in durable project/repo requests;
 * callers serialize it canonically before persisting the original string.
 */
export function parseConfigRepoTemplateReference(input: string): ConfigRepoTemplateReference {
  const value = input.trim();
  if (value.length === 0) throw new Error("Config template reference cannot be empty.");

  const fragmentStart = value.indexOf("#");
  if (fragmentStart !== -1 && value.indexOf("#", fragmentStart + 1) !== -1) {
    throw new Error("Config template reference contains more than one # fragment separator.");
  }
  const repositoryPart = fragmentStart === -1 ? value : value.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? undefined : value.slice(fragmentStart + 1);
  if (fragment === "") throw new Error("Config template reference has an empty # fragment.");

  let owner: string;
  let repo: string;
  if (repositoryPart.startsWith("github:")) {
    const segments = repositoryPart.slice("github:".length).split("/");
    if (segments.length !== 2) {
      throw new Error('GitHub shorthand must be "github:owner/repo".');
    }
    [owner, repo] = segments;
  } else if (repositoryPart.startsWith("git+https://")) {
    let repositoryUrl: URL;
    try {
      repositoryUrl = new URL(repositoryPart.slice("git+".length));
    } catch {
      throw new Error("Config template git+https URL is invalid.");
    }
    if (
      repositoryUrl.protocol !== "https:" ||
      repositoryUrl.hostname.toLowerCase() !== "github.com" ||
      repositoryUrl.port !== "" ||
      repositoryUrl.username !== "" ||
      repositoryUrl.password !== "" ||
      repositoryUrl.search !== ""
    ) {
      throw new Error("Config templates must use a credential-free https://github.com URL.");
    }
    const segments = repositoryUrl.pathname.split("/").filter(Boolean);
    if (segments.length !== 2) {
      throw new Error("Config template GitHub URL must identify exactly one owner and repository.");
    }
    [owner, repo] = segments;
  } else {
    throw new Error(
      'Config template reference must start with "github:" or "git+https://github.com/".',
    );
  }

  if (repo.toLowerCase().endsWith(".git")) repo = repo.slice(0, -4);
  if (!GITHUB_OWNER_PATTERN.test(owner)) {
    throw new Error(`Invalid GitHub owner in config template reference: ${JSON.stringify(owner)}.`);
  }
  if (!GITHUB_REPO_PATTERN.test(repo) || repo === "." || repo === "..") {
    throw new Error(
      `Invalid GitHub repository in config template reference: ${JSON.stringify(repo)}.`,
    );
  }

  let ref: string | undefined;
  let path: string | undefined;
  if (fragment?.startsWith("path:") === true) {
    path = fragment.slice("path:".length);
  } else if (fragment !== undefined) {
    const pathSeparator = fragment.indexOf("&path:");
    if (pathSeparator === -1) ref = fragment;
    else {
      ref = fragment.slice(0, pathSeparator);
      path = fragment.slice(pathSeparator + "&path:".length);
    }
  }

  if (ref !== undefined) {
    if (
      ref.length === 0 ||
      ref.startsWith("/") ||
      ref.endsWith("/") ||
      ref.endsWith(".") ||
      ref.endsWith(".lock") ||
      ref.includes("..") ||
      ref.includes("@{") ||
      ref.includes("//") ||
      Array.from(ref).some(
        (character) => character.charCodeAt(0) <= 32 || "~^:?*[\\&".includes(character),
      )
    ) {
      throw new Error(`Invalid Git ref in config template reference: ${JSON.stringify(ref)}.`);
    }
  }

  if (path !== undefined) {
    if (!isSafeConfigRepoTemplatePath(path)) {
      throw new Error(`Invalid path in config template reference: ${JSON.stringify(path)}.`);
    }
  }

  return {
    owner,
    ...(path === undefined ? {} : { path }),
    ...(ref === undefined ? {} : { ref }),
    repo,
  };
}

export function formatConfigRepoTemplateReference(reference: ConfigRepoTemplateReference): string {
  const repository = `github:${reference.owner}/${reference.repo}`;
  if (reference.ref !== undefined && reference.path !== undefined) {
    return `${repository}#${reference.ref}&path:${reference.path}`;
  }
  if (reference.ref !== undefined) return `${repository}#${reference.ref}`;
  if (reference.path !== undefined) return `${repository}#path:${reference.path}`;
  return repository;
}

export function normalizeConfigRepoTemplateReference(input: string): string {
  return formatConfigRepoTemplateReference(parseConfigRepoTemplateReference(input));
}
