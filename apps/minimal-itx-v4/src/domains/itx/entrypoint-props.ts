import { TRUSTED_INTERNAL_ITX_TOKEN } from "../../auth.ts";
import { normalizePath } from "../durable-object-names.ts";
import type { ItxAuthCredentials } from "./types.ts";

export type ItxEntrypointScope = {
  path: string;
  projectId: string;
};

export type ScopedItxEntrypointProps = ItxEntrypointScope & {
  auth?: ItxAuthCredentials;
};

export type ItxEntrypointProps = ItxAuthCredentials | ScopedItxEntrypointProps;

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

export function authCredentialsFromItxEntrypointProps(
  props: ItxEntrypointProps | undefined,
): ItxAuthCredentials {
  if (props === undefined) return TRUSTED_INTERNAL_ITX_PROPS;
  if (isItxAuthCredentials(props)) return props;
  return props.auth ?? TRUSTED_INTERNAL_ITX_PROPS;
}

export function scopeFromItxEntrypointProps(
  props: ItxEntrypointProps | undefined,
): ItxEntrypointScope {
  if (props === undefined || isItxAuthCredentials(props)) {
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

function isItxAuthCredentials(props: ItxEntrypointProps): props is ItxAuthCredentials {
  return (
    "type" in props &&
    (props.type === "from-server-cookie" ||
      props.type === "token" ||
      props.type === "trusted-internal")
  );
}
