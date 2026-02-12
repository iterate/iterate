type URLSearchQueryInit =
  | string
  | string[][]
  | Record<string, string>
  | URLSearchParams
  | undefined;

export function buildProjectIngressLink(params: {
  baseUrl: string;
  path: string;
  query?: URLSearchQueryInit;
}): string {
  const { baseUrl, path, query } = params;
  const url = new URL(baseUrl);
  url.pathname = joinPathnames(url.pathname, path);

  if (query) {
    url.search = new URLSearchParams(query).toString();
  } else {
    url.search = "";
  }

  return url.toString();
}

function joinPathnames(basePathname: string, nextPathname: string): string {
  const baseSegments = basePathname.split("/").filter(Boolean);
  const nextSegments = nextPathname.split("/").filter(Boolean);
  const segments = [...baseSegments, ...nextSegments];
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}
