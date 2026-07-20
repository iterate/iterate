/** Display identity announced by an authenticated browser stream subscriber. */
export type BrowserStreamSubscriberUser = {
  email: string;
  name?: string;
};

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
