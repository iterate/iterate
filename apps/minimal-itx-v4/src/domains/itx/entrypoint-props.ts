import { normalizePath } from "../durable-object-names.ts";

export type ItxEntrypointScope = {
  path: string;
  projectId: string;
};

export type ItxEntrypointProps = ItxEntrypointScope;

export function itxEntrypointProps(input: ItxEntrypointScope): ItxEntrypointProps {
  return {
    path: normalizePath(input.path),
    projectId: input.projectId,
  };
}

export function scopeFromItxEntrypointProps(
  props: ItxEntrypointProps | undefined,
): ItxEntrypointScope {
  if (props === undefined) {
    throw new Error("env.ITX.get() requires ITX binding props with projectId and path");
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
