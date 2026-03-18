import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  ArrowUpRight,
  BookOpenText,
  Database,
  Globe,
  Home,
  Settings2,
  SquareTerminal,
  Waypoints,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@iterate-com/ui/components/sidebar";
import { Badge } from "@iterate-com/ui/components/badge";
import {
  fetchLandingData,
  getDbSourceForRoute,
  getDocsSourceForRoute,
  hostLabel,
  type LandingDataResponse,
} from "@/lib/landing.ts";

const staticItems = [
  { to: "/", label: "Home", icon: Home, exact: true },
  { to: "/streams", label: "Event Streams", icon: Activity, exact: true },
  { to: "/terminal", label: "Terminal", icon: SquareTerminal, exact: true },
  { to: "/config", label: "Config", icon: Settings2, exact: true },
  { to: "/caddy", label: "Caddy", icon: Waypoints, exact: true },
] as const;

function isActivePath(pathname: string, to: string, exact: boolean) {
  if (exact) return pathname === to;
  return pathname === to || pathname.startsWith(`${to}/`);
}

export function AppSidebar() {
  const pathname = useLocation().pathname;
  const { data } = useQuery<LandingDataResponse>({
    queryKey: ["registry", "landing"],
    queryFn: fetchLandingData,
  });
  const services = (data?.routes ?? [])
    .map((route) => {
      const docsSource = getDocsSourceForRoute(data, route);
      const dbSource = getDbSourceForRoute(data, route);
      const headline = hostLabel(route.publicURL);
      return {
        id: route.host,
        slug: route.host,
        headline,
        docsHref: docsSource ? `/routes/${encodeURIComponent(route.host)}/docs` : undefined,
        dbHref: dbSource ? `/routes/${encodeURIComponent(route.host)}/db` : undefined,
        openHref: route.publicURL,
      };
    })
    .sort((a, b) => {
      if (a.headline === "iterate.localhost" && b.headline !== "iterate.localhost") return -1;
      if (a.headline !== "iterate.localhost" && b.headline === "iterate.localhost") return 1;
      return a.headline.localeCompare(b.headline);
    });

  return (
    <Sidebar className="border-r-0">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/routes">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold">
                  R
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">registry</span>
                  <span className="truncate text-xs">control plane</span>
                </div>
                <Badge variant="secondary">start</Badge>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarMenu>
          {staticItems.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton asChild isActive={isActivePath(pathname, item.to, item.exact)}>
                <Link to={item.to}>
                  <item.icon className="size-4 shrink-0" />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>

        <div className="mt-4 space-y-3 px-2 pb-4">
          {services.map((service) => (
            <div key={service.id} className="space-y-1">
              <SidebarMenuButton
                asChild
                isActive={pathname === `/routes/${service.slug}`}
                className="h-7 justify-start px-2"
              >
                <Link to="/routes/$slug" params={{ slug: service.slug }}>
                  <span className="truncate font-mono text-[11px]">{service.headline}</span>
                </Link>
              </SidebarMenuButton>

              <div className="space-y-1 pl-4">
                <SidebarMenuButton
                  asChild
                  size="sm"
                  isActive={pathname === `/routes/${service.slug}`}
                  className="h-7 justify-start"
                >
                  <Link to="/routes/$slug" params={{ slug: service.slug }}>
                    <Globe className="size-3.5 shrink-0" />
                    <span>Routes</span>
                  </Link>
                </SidebarMenuButton>
                {service.docsHref ? (
                  <SidebarMenuButton
                    asChild
                    size="sm"
                    isActive={pathname === `/routes/${service.slug}/docs`}
                    className="h-7 justify-start"
                  >
                    <Link to="/routes/$slug/docs" params={{ slug: service.slug }}>
                      <BookOpenText className="size-3.5 shrink-0" />
                      <span>Openapi docs</span>
                    </Link>
                  </SidebarMenuButton>
                ) : null}
                {service.dbHref ? (
                  <SidebarMenuButton
                    asChild
                    size="sm"
                    isActive={pathname === `/routes/${service.slug}/db`}
                    className="h-7 justify-start"
                  >
                    <Link to="/routes/$slug/db" params={{ slug: service.slug }}>
                      <Database className="size-3.5 shrink-0" />
                      <span>DB</span>
                    </Link>
                  </SidebarMenuButton>
                ) : null}
                <SidebarMenuButton asChild size="sm" className="h-7 justify-start">
                  <a href={service.openHref} target="_blank" rel="noreferrer">
                    <ArrowUpRight className="size-3.5 shrink-0" />
                    <span>Open</span>
                  </a>
                </SidebarMenuButton>
              </div>
            </div>
          ))}
        </div>
      </SidebarContent>
    </Sidebar>
  );
}
