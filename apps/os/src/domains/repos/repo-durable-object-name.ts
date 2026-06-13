/**
 * Repo DO naming, in its own module so light consumers (itx source builds,
 * the repos capability) can derive names without bundling the repo Durable
 * Object implementation — repo-durable-object.ts drags isomorphic-git and
 * @cloudflare/shell into any worker that value-imports it.
 */
import { deriveDurableObjectNameFromStructuredName } from "@iterate-com/shared/durable-object-utils/mixins/with-lifecycle-hooks";

export type RepoStructuredName = {
  projectId: string;
  repoSlug: string;
};

export function getRepoDurableObjectName(name: RepoStructuredName) {
  return deriveDurableObjectNameFromStructuredName({
    structuredName: name,
  });
}
