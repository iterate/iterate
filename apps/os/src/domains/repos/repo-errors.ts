export function isRepoAlreadyExistsError(error: unknown) {
  return error instanceof Error && /Repo .* already exists\./.test(error.message);
}

export function isRepoNotCreatedError(error: unknown) {
  return error instanceof Error && /Repo .* has not been created\./.test(error.message);
}

export function isRepoNotFoundError(error: unknown) {
  return error instanceof Error && /Repo .* not found\./.test(error.message);
}
