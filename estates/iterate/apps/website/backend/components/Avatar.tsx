import { forwardRef } from "react";
import { cn } from "../utils/cn.ts";

interface AvatarProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: "sm" | "md" | "lg";
}

const Avatar = forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, size = "md", ...props }, ref) => {
    const sizeStyles = {
      sm: "h-10 w-10",
      md: "h-20 w-20",
      lg: "h-32 w-32",
    };

    return (
      <div
        ref={ref}
        className={cn(
          "relative flex shrink-0 overflow-hidden rounded-full bg-white border border-gray-200 aspect-square",
          sizeStyles[size],
          className,
        )}
        {...props}
      />
    );
  },
);

Avatar.displayName = "Avatar";

interface AvatarImageProps extends React.ImgHTMLAttributes<HTMLImageElement> {}

const AvatarImage = forwardRef<HTMLImageElement, AvatarImageProps>(
  ({ className, alt = "Avatar", ...props }, ref) => (
    <img
      alt={alt}
      ref={ref}
      className={cn("aspect-square h-full w-full object-cover", className)}
      {...props}
    />
  ),
);

AvatarImage.displayName = "AvatarImage";

interface AvatarFallbackProps extends React.HTMLAttributes<HTMLDivElement> {}

const AvatarFallback = forwardRef<HTMLDivElement, AvatarFallbackProps>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "flex h-full w-full items-center justify-center rounded-full bg-gray-100 text-xl font-semibold text-gray-600",
        className,
      )}
      {...props}
    />
  ),
);

AvatarFallback.displayName = "AvatarFallback";

// Compound component pattern
const AvatarCompound = Object.assign(Avatar, {
  Image: AvatarImage,
  Fallback: AvatarFallback,
});

export { Avatar, AvatarImage, AvatarFallback };
export default AvatarCompound;
