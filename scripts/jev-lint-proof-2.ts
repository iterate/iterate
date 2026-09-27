type Inbox = { count(): Promise<number> };

// Until 2026-09-20 we used to read the inbox twice here, and the soak run on ci-0918 showed why.
export async function unread(stub: unknown): Promise<number> {
  return (stub as Inbox).count();
}
