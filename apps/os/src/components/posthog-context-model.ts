import type { PublicSessionResponse } from "@iterate-com/auth/client";
import type {
  PosthogGroup,
  PosthogPerson,
  PosthogProperties,
} from "@iterate-com/ui/components/posthog";

export type RouteProject = {
  id: string;
  organizationId: string | null;
  slug: string;
};

/**
 * The authenticated user is a PostHog person. Organization and project are
 * group types; modelling the user as a third group would duplicate identity
 * and opt every identified event into another unnecessary group dimension.
 */
export function osPosthogContext(
  session: PublicSessionResponse | null,
  project: RouteProject | null,
): {
  eventProperties: PosthogProperties;
  groups: PosthogGroup[];
  person: PosthogPerson;
} | null {
  if (!session?.authenticated) return null;

  const personProperties: PosthogProperties = {
    email: session.user.email,
    is_admin: session.user.isAdmin === true,
  };
  if (session.user.name) personProperties.name = session.user.name;
  if (session.user.role) personProperties.role = session.user.role;
  if (session.user.emailVerified !== undefined) {
    personProperties.email_verified = session.user.emailVerified;
  }

  const eventProperties: PosthogProperties = {};
  const groups: PosthogGroup[] = [];
  // A project-scoped operator grant uses an artificial `operator:<project>`
  // organization solely as an authorization boundary. It is not a product
  // organization and must not pollute the analytics group catalog.
  const organizationId =
    session.session.scope === "operator project"
      ? null
      : project
        ? project.organizationId
        : (session.session.activeOrganizationId ?? null);
  if (organizationId) {
    eventProperties.organization_id = organizationId;
    const organization = session.session.organizations.find(
      (candidate) => candidate.id === organizationId,
    );
    const organizationProperties: PosthogProperties = { id: organizationId };
    if (organization) {
      organizationProperties.name = organization.name;
      organizationProperties.slug = organization.slug;
    }
    groups.push({
      type: "organization",
      key: organizationId,
      properties: organizationProperties,
    });
  }

  if (project) {
    eventProperties.project_id = project.id;
    const projectProperties: PosthogProperties = {
      id: project.id,
      name: project.slug,
      slug: project.slug,
    };
    if (organizationId) projectProperties.organization_id = organizationId;
    groups.push({
      type: "project",
      key: project.id,
      properties: projectProperties,
    });
  }

  return {
    eventProperties,
    person: {
      distinctId: session.user.id,
      properties: personProperties,
    },
    groups,
  };
}
