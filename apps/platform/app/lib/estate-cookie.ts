const ESTATE_COOKIE_NAME = "iterate-selected-estate";

export function getSelectedEstateId(): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const cookies = document.cookie.split(";");
  const estateCookie = cookies.find((cookie) => cookie.trim().startsWith(`${ESTATE_COOKIE_NAME}=`));

  if (!estateCookie) {
    return null;
  }

  return estateCookie.split("=")[1] || null;
}

export function setSelectedEstateId(estateId: string): void {
  if (typeof document === "undefined") {
    return;
  }

  // Set cookie with 30 day expiration
  const expires = new Date();
  expires.setDate(expires.getDate() + 30);

  document.cookie = `${ESTATE_COOKIE_NAME}=${estateId}; expires=${expires.toUTCString()}; path=/; SameSite=Lax`;
}

export function clearSelectedEstateId(): void {
  if (typeof document === "undefined") {
    return;
  }

  document.cookie = `${ESTATE_COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
}
