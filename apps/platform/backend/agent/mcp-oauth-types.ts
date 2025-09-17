import { z } from "zod/v4";

/** OAuth 2.0 Protected Resource Metadata: https://datatracker.ietf.org/doc/html/rfc9728 */
export const ProtectedResourceMetadata = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()),
  bearer_methods_supported: z.array(z.string()).optional(),
  resource_signing_alg_values_supported: z.array(z.string()).optional(),
  resource_documentation: z.string().url().optional(),
  resource_policy_uri: z.string().url().optional(),
  resource_tos_uri: z.string().url().optional(),
});

export type ProtectedResourceMetadata = z.infer<typeof ProtectedResourceMetadata>;

/** OAuth 2.0 Authorization Server Metadata: https://datatracker.ietf.org/doc/html/rfc8414 */
export const AuthorizationServerMetadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  jwks_uri: z.string().url().optional(),
  registration_endpoint: z.string().url().optional(),
  scopes_supported: z.array(z.string()).optional(),
  response_types_supported: z.array(z.string()),
  response_modes_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_signing_alg_values_supported: z.array(z.string()).optional(),
  service_documentation: z.string().url().optional(),
  ui_locales_supported: z.array(z.string()).optional(),
  op_policy_uri: z.string().url().optional(),
  op_tos_uri: z.string().url().optional(),
  revocation_endpoint: z.string().url().optional(),
  revocation_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  introspection_endpoint: z.string().url().optional(),
  introspection_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});

export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadata>;

/** OAuth 2.0 Dynamic Client Registration Request: https://datatracker.ietf.org/doc/html/rfc7591 */
export const ClientRegistrationRequest = z.object({
  redirect_uris: z.array(z.string()),
  token_endpoint_auth_method: z.string().optional().default("none"),
  grant_types: z.array(z.string()).optional().default(["authorization_code", "refresh_token"]),
  response_types: z.array(z.string()).optional().default(["code"]),
  client_name: z.string().optional(),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.string().url().optional(),
  policy_uri: z.string().url().optional(),
  jwks_uri: z.string().url().optional(),
  jwks: z.any().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
});

export type ClientRegistrationRequest = z.infer<typeof ClientRegistrationRequest>;

/** OAuth 2.0 Dynamic Client Registration Response: https://datatracker.ietf.org/doc/html/rfc7591 */
export const ClientRegistrationResponse = z.object({
  client_id: z.string(),
  client_secret: z.string().optional(),
  registration_access_token: z.string().optional(),
  registration_client_uri: z.string().optional(),
  client_id_issued_at: z.number().optional(),
  client_secret_expires_at: z.number().optional(),
  /** All request fields can be returned */
  redirect_uris: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  client_name: z.string().optional(),
  client_uri: z.string().url().optional(),
  logo_uri: z.string().url().optional(),
  scope: z.string().optional(),
  contacts: z.array(z.string()).optional(),
  tos_uri: z.string().url().optional(),
  policy_uri: z.string().url().optional(),
  jwks_uri: z.string().url().optional(),
  jwks: z.any().optional(),
  software_id: z.string().optional(),
  software_version: z.string().optional(),
});

export type ClientRegistrationResponse = z.infer<typeof ClientRegistrationResponse>;

/** WWW-Authenticate header parsing */
export interface WWWAuthenticateChallenge {
  scheme: string;
  realm?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  resource_metadata?: string;
  [key: string]: string | undefined;
}
