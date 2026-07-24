export type LoginRedirectSearch = {
  redirect: string;
  error?: string;
  error_description?: string;
};

export function getLoginRedirectSearch(href: string): LoginRedirectSearch {
  const destination = new URL(href, "https://iterate-auth.local");
  const error = destination.searchParams.get("error") || undefined;
  if (!error) return { redirect: href };

  const errorDescription = destination.searchParams.get("error_description") || undefined;
  destination.searchParams.delete("error");
  destination.searchParams.delete("error_description");

  const redirect = `${destination.pathname}${destination.search}${destination.hash}`;
  return {
    redirect,
    error,
    ...(errorDescription ? { error_description: errorDescription } : {}),
  };
}
