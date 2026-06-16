/**
 * Repo DO naming, in its own module so light consumers (itx source builds,
 * the repos capability) can derive names without bundling the repo Durable
 * Object implementation — repo-durable-object.ts drags isomorphic-git and
 * @cloudflare/shell into any worker that value-imports it.
 */
import { StreamPath, type StreamPath as StreamPathType } from "@iterate-com/shared/streams/types";
import { formatDurableObjectName } from "~/domains/durable-object-names.ts";

export type RepoDurableObjectName = {
  projectId: string;
  path: StreamPathType | string;
};

export function getRepoDurableObjectName(name: RepoDurableObjectName) {
  return formatDurableObjectName({
    path: repoStreamPath(name.path),
    projectId: name.projectId,
  });
}

export function repoStreamPath(path: StreamPathType | string) {
  return StreamPath.parse(String(path));
}
