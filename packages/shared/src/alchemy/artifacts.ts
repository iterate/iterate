export type ArtifactsBinding = {
  type: "artifacts";
  namespace: string;
};

export function Artifacts(input: { namespace: string }): ArtifactsBinding {
  return {
    type: "artifacts",
    namespace: input.namespace,
  };
}
