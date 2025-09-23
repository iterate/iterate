export function getStage(env: {
  ITERATE_USER?: string;
  STAGE__PR_ID?: string;
  ESTATE_NAME?: string;
}) {
  const { STAGE__PR_ID, ITERATE_USER, ESTATE_NAME } = env;
  if (STAGE__PR_ID) {
    return `pr-${STAGE__PR_ID}`;
  }
  if (ITERATE_USER) {
    return `local-${ITERATE_USER}`;
  }
  if (ESTATE_NAME) {
    return `estate-${ESTATE_NAME}`;
  }
  throw new Error("Failed to resolve stage");
}
