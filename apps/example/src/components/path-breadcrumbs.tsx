import { Fragment } from "react";
import { Link, useMatches } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@iterate-com/ui/components/breadcrumb";

type BreadcrumbStaticData = {
  breadcrumb?: string;
  breadcrumbTo?: string;
};

type BreadcrumbLoaderData = {
  breadcrumb?: string;
  breadcrumbTo?: string;
};

export function PathBreadcrumbs() {
  const matches = useMatches();

  if (matches.some((match) => match.status === "pending")) {
    return null;
  }

  const crumbs = matches.flatMap((match) => {
    const staticBreadcrumb = (match.staticData as BreadcrumbStaticData | undefined)?.breadcrumb;
    const dynamicBreadcrumb = (match.loaderData as BreadcrumbLoaderData | undefined)?.breadcrumb;
    const staticBreadcrumbTo = (match.staticData as BreadcrumbStaticData | undefined)?.breadcrumbTo;
    const dynamicBreadcrumbTo = (match.loaderData as BreadcrumbLoaderData | undefined)
      ?.breadcrumbTo;
    const label = dynamicBreadcrumb ?? staticBreadcrumb;

    if (!label) {
      return [];
    }

    return [
      {
        id: match.id,
        label,
        to: dynamicBreadcrumbTo ?? staticBreadcrumbTo ?? match.pathname,
      },
    ];
  });

  if (crumbs.length === 0) {
    return null;
  }

  const lastCrumb = crumbs.at(-1);
  const parentCrumbs = crumbs.slice(0, -1);

  if (!lastCrumb) {
    return null;
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {parentCrumbs.map((crumb) => (
          <Fragment key={crumb.id}>
            <BreadcrumbItem className="hidden md:inline-flex">
              <BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden md:block" />
          </Fragment>
        ))}

        {parentCrumbs.length > 0 && (
          <>
            <BreadcrumbItem className="md:hidden">
              <BreadcrumbEllipsis className="size-auto" />
            </BreadcrumbItem>
            <BreadcrumbSeparator className="md:hidden" />
          </>
        )}

        <BreadcrumbItem>
          <BreadcrumbPage className="max-w-[16rem] truncate">{lastCrumb.label}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
