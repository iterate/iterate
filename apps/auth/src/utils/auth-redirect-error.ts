export type LoginRedirectSearch = {
  redirect: string;
  error?: string;
  error_description?: string;
};

export function getLoginRedirectSearch(href: string): LoginRedirectSearch {
  let destination: URL;
  try {
    destination = new URL(href, "https://iterate-auth.local");
  } catch (error) {
    if (error instanceof TypeError) return { redirect: href };
    throw error;
  }

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
