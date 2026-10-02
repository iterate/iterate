/** A date as a person reads it — the day and the month, and the year when it is not this one —
 *  the same on the server and in the browser: en-GB, in UTC. */
export const dateOf = (at: number) =>
  new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(new Date(at).getUTCFullYear() !== new Date().getUTCFullYear() && { year: "numeric" }),
    timeZone: "UTC",
  }).format(at);
