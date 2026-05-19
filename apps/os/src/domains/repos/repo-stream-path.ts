import { StreamPath } from "@iterate-com/shared/streams/types";

export function repoStreamPath(repoSlug: string) {
  return StreamPath.parse(`/repos/${repoSlug}`);
}
