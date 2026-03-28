import playwrightConfig from "../../playwright.config.ts";

export const specBaseUrl = String(playwrightConfig.use.baseURL);

export async function fetchWithManualRedirect(
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  let url = new URL(input, specBaseUrl);
  let redirectsRemaining = 5;

  while (true) {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
    });

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const redirectLocation = response.headers.get("location");
    if (!redirectLocation || redirectsRemaining <= 0) {
      return response;
    }

    url = new URL(redirectLocation, url);
    redirectsRemaining -= 1;
  }
}
