import { createPrivateKey } from "crypto";
import { SignJWT } from "jose";
import { env } from "../../../env.ts";

export const generateGithubJWT = async () => {
  const alg = "RS256";
  const now = Math.floor(Date.now() / 1000);
  const key = createPrivateKey({
    key: env.GITHUB_APP_PRIVATE_KEY,
    format: "pem",
  });

  return await new SignJWT({})
    .setProtectedHeader({ alg, typ: "JWT" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(env.GITHUB_APP_CLIENT_ID)
    .sign(key);
};
