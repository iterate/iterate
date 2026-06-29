import { TRUSTED_INTERNAL_ITX_TOKEN } from "../../auth.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { ItxAuthCredentials } from "./types.ts";

export type ItxEntrypointScope = {
  path: string;
  projectId: string;
};

export type ScopedItxEntrypointProps = ItxEntrypointScope;
export type ItxEntrypointProps = ScopedItxEntrypointProps;

export const TRUSTED_INTERNAL_ITX_PROPS = {
  token: TRUSTED_INTERNAL_ITX_TOKEN,
  type: "trusted-internal",
} satisfies ItxAuthCredentials;

export function scopedItxEntrypointProps(input: ItxEntrypointScope): ScopedItxEntrypointProps {
  return {
    path: normalizePath(input.path),
    projectId: input.projectId,
  };
}

export function scopeFromItxEntrypointProps(
  props: ItxEntrypointProps | undefined,
): ItxEntrypointScope {
  if (props === undefined) {
    throw new Error("env.ITX.get() requires scoped ITX binding props with projectId and path");
  }
  if (props.projectId.trim() === "") {
    throw new Error("env.ITX.get() requires a non-empty projectId");
  }
  return {
    path: normalizePath(props.path),
    projectId: props.projectId,
  };
}

export function itxEntrypointScopeCacheKey(scope: ItxEntrypointScope): string {
  return JSON.stringify({
    path: normalizePath(scope.path),
    projectId: scope.projectId,
  });
}
