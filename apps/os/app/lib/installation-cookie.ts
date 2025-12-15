const INSTALLATION_COOKIE_NAME = "iterate-selected-installation";

export interface SelectedInstallation {
  organizationId: string;
  installationId: string;
}

export function getSelectedInstallation(): SelectedInstallation | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cookies = document.cookie.split(";");
  const installationCookie = cookies.find((cookie) =>
    cookie.trim().startsWith(`${INSTALLATION_COOKIE_NAME}=`),
  );

  if (!installationCookie) {
    return null;
  }

  try {
    const value = installationCookie.split("=")[1];
    if (!value) {
      return null;
    }

    // Decode and parse the JSON value
    const decoded = decodeURIComponent(value);
    return JSON.parse(decoded) as SelectedInstallation;
  } catch {
    // If parsing fails, return null and clear the invalid cookie
    clearSelectedInstallation();
    return null;
  }
}

export function setSelectedInstallation(organizationId: string, installationId: string): void {
  if (typeof document === "undefined") {
    return;
  }

  // Create the installation object
  const installation: SelectedInstallation = { organizationId, installationId };

  // Encode the JSON value
  const encoded = encodeURIComponent(JSON.stringify(installation));

  // Set cookie with 30 day expiration
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  document.cookie = `${INSTALLATION_COOKIE_NAME}=${encoded}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;
}

export function clearSelectedInstallation(): void {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${INSTALLATION_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}
