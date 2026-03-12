import { z } from "zod/v4";

const nonEmptyString = z.string().trim().min(1);

// Provider cases parse these schemas at test start so missing env fails exactly
// when that case runs, while still keeping the case body provider-agnostic.
export const DockerDeploymentTestEnv = z
  .object({
    E2E_DOCKER_IMAGE_REF: nonEmptyString.optional(),
    JONASLAND_SANDBOX_IMAGE: nonEmptyString.optional(),
  })
  .transform(({ E2E_DOCKER_IMAGE_REF, JONASLAND_SANDBOX_IMAGE }) => ({
    image: E2E_DOCKER_IMAGE_REF ?? JONASLAND_SANDBOX_IMAGE ?? "debian:trixie-slim",
  }));

// The Fly schema mirrors the Docker shape, but adds the credentials and
// provider-specific image input needed to create or reconnect a Fly machine.
export const FlyDeploymentTestEnv = z
  .object({
    // TODO fix this - these are not all valid inputs
    E2E_DOCKER_IMAGE_REF: nonEmptyString.optional(),
    E2E_FLY_IMAGE_REF: nonEmptyString.optional(),
    JONASLAND_SANDBOX_IMAGE: nonEmptyString.optional(),
    FLY_API_TOKEN: nonEmptyString,
  })
  .transform(
    ({ E2E_DOCKER_IMAGE_REF, E2E_FLY_IMAGE_REF, JONASLAND_SANDBOX_IMAGE, FLY_API_TOKEN }) => ({
      flyApiToken: FLY_API_TOKEN,
      image:
        E2E_FLY_IMAGE_REF ??
        E2E_DOCKER_IMAGE_REF ??
        JONASLAND_SANDBOX_IMAGE ??
        "debian:trixie-slim",
    }),
  );
