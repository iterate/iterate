import type { ReactElement } from "react";
import { cn } from "../utils/cn.ts";
import { TwitterIcon, LinkedInIcon } from "./Icons.tsx";

interface Social {
  x?: string;
  linkedIn?: string;
}

interface MemberProps {
  image?: string;
  name: string;
  companyRole: string | ReactElement;
  social: Social;
  className?: string;
}

export default function Member({ image, name, companyRole, social, className }: MemberProps) {
  return (
    <div className={cn("mb-6", className)}>
      <div className="flex items-start gap-3">
        <div className="relative flex h-12 w-12 shrink-0 overflow-hidden rounded-full bg-gray-100 aspect-square select-none pointer-events-none">
          {image ? (
            <img
              src={image}
              alt={name}
              className="aspect-square h-full w-full object-cover bg-center"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-gray-600">
              {name.split(" ").map((n) => n[0])}
            </div>
          )}
        </div>
        <div className="flex-1">
          <h4 className="font-semibold text-sm">{name}</h4>
          <span className="text-gray-600 text-xs">{companyRole}</span>
          <div className="flex gap-2 mt-1">
            {social.linkedIn && (
              <a
                href={social.linkedIn}
                aria-label={`Visit ${name}'s LinkedIn profile`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-900 transition-colors duration-150"
              >
                <LinkedInIcon size={16} />
              </a>
            )}
            {social.x && (
              <a
                href={social.x}
                aria-label={`Visit ${name}'s X (Twitter) profile`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-600 hover:text-gray-900 transition-colors duration-150"
              >
                <TwitterIcon size={14} />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
