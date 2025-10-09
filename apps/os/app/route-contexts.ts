/**
 * Shared context types for React Router outlets
 * These define the data passed from parent route loaders to child routes via useOutletContext
 */

export interface OrgContext {
  organization: {
    id: string;
    name: string;
    stripeCustomerId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  organizations: Array<{
    id: string;
    name: string;
    role: "external" | "member" | "admin" | "owner" | "guest";
    stripeCustomerId: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
}
