/** Enforced by the coordinator, including requests from older preview clients. */
export function resourceReservations(type: string) {
  return type === "environment-config-lease" ? [{ slug: "preview-1", holder: "main-preview" }] : [];
}

export function resourceAllowedForHolder(type: string, slug: string, holder: string | null) {
  // GC acquires expired/free slots without force, holds them while erasing,
  // then releases. Main must wait while that maintenance lease is active.
  if (type === "environment-config-lease" && holder === "gc") return true;
  const reservations = resourceReservations(type);
  const owned = reservations.find((reservation) => reservation.holder === holder);
  if (owned) return owned.slug === slug;
  return !reservations.some((reservation) => reservation.slug === slug);
}
