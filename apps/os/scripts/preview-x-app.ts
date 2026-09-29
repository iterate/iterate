import { dummyPetshopEnvs } from "../../../envs.ts";

/** Preview deployments connect to the fake X provider. Live credentials belong in Doppler. */
export const PREVIEW_X_APP = {
  oauthClientId: "petshop-default",
  oauthClientSecret: "petshop-default-secret",
  xOrigin: dummyPetshopEnvs.prd!.baseUrl,
};
