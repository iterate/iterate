const INSTALLATION_COOKIE_NAME = "iterate-selected-estate";

export interface SelectedEstate {
  organizationId: string;
  installationId: string;
}

export function getSelectedEstate(): SelectedEstate | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cookies = document.cookie.split(";");
  const estateCookie = cookies.find((cookie) => cookie.trim().startsWith(`${INSTALLATION_COOKIE_NAME}=`));

  if (!estateCookie) {
    return null;
  }

  try {
    const value = estateCookie.split("=")[1];
    if (!value) {
      return null;
    }

    // Decode and parse the JSON value
    const decoded = decodeURIComponent(value);
    return JSON.parse(decoded) as SelectedEstate;
  } catch {
    // If parsing fails, return null and clear the invalid cookie
    clearSelectedEstate();
    return null;
  }
}

export function setSelectedEstate(organizationId: string, installationId: string): void {
  if (typeof document === "undefined") {
    return;
  }

  // Create the estate object
  const estate: SelectedEstate = { organizationId, installationId };

  // Encode the JSON value
  const encoded = encodeURIComponent(JSON.stringify(estate));

  // Set cookie with 30 day expiration
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  document.cookie = `${INSTALLATION_COOKIE_NAME}=${encoded}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;
}

export function clearSelectedEstate(): void {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${INSTALLATION_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}
