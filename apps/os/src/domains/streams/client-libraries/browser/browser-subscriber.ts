/** Display identity announced by an authenticated browser stream subscriber. */
export type BrowserStreamSubscriberUser = {
  email: string;
  name?: string;
};

/**
 * Apply an auth-session identity update to a browser subscriber. A live
 * subscription must reconnect so its server-side presence descriptor cannot
 * retain the previous user's identity (including across logout).
 */
export function browserStreamSubscriberUserUpdate(args: {
  current: BrowserStreamSubscriberUser | undefined;
  next: BrowserStreamSubscriberUser | undefined;
  started: boolean;
}): { user: BrowserStreamSubscriberUser | undefined; reconnect: boolean } {
  const unchanged =
    args.current?.email === args.next?.email && args.current?.name === args.next?.name;
  return {
    user: args.next,
    reconnect: !unchanged && args.started,
  };
}

/**
 * Build the serializable descriptor journaled in stream presence facts.
 * Generic over the announcement so this browser-only helper does not need to
 * duplicate the processor contract's public type.
 */
export function browserStreamSubscriberDescriptor<Announcement>(args: {
  announcement: Announcement;
  user?: BrowserStreamSubscriberUser;
}) {
  return {
    description: "browser",
    processor: { announcement: args.announcement },
    ...(args.user === undefined ? {} : { user: args.user }),
  };
}
