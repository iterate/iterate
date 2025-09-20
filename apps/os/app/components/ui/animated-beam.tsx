import { forwardRef, useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";
import { cn } from "../../lib/utils.ts";

export interface AnimatedBeamProps {
  className?: string;
  containerRef: React.RefObject<HTMLElement>;
  fromRef: React.RefObject<HTMLElement>;
  toRef: React.RefObject<HTMLElement>;
  curvature?: number;
  reverse?: boolean;
  pathWidth?: number;
  pathOpacity?: number;
  delay?: number;
  duration?: number;
  startXOffset?: number;
  startYOffset?: number;
  endXOffset?: number;
  endYOffset?: number;
}

export const AnimatedBeam = forwardRef<SVGSVGElement, AnimatedBeamProps>(
  (
    {
      className,
      containerRef,
      fromRef,
      toRef,
      curvature = 0,
      reverse = false,
      duration = 2,
      delay = 300,
      pathWidth = 4,
      pathOpacity = 0.2,
      startXOffset = 0,
      startYOffset = 0,
      endXOffset = 0,
      endYOffset = 0,
    },
    ref,
  ) => {
    const id = useId();
    const [pathD, setPathD] = useState("");
    const [svgDimensions, setSvgDimensions] = useState({ width: 0, height: 0 });
    const [animationDirection, setAnimationDirection] = useState(reverse);

    const gradientId = `gradient-${id}`;
    const pathId = `path-${id}`;

    const { theme } = useTheme();

    const pathColor = theme === "dark" ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)";
    const gradientStartColor = theme === "dark" ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.6)";
    const gradientStopColor = theme === "dark" ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.6)";

    useEffect(() => {
      const updatePath = () => {
        if (containerRef.current && fromRef.current && toRef.current) {
          const containerRect = containerRef.current.getBoundingClientRect();
          const rectA = fromRef.current.getBoundingClientRect();
          const rectB = toRef.current.getBoundingClientRect();

          const svgWidth = containerRect.width;
          const svgHeight = containerRect.height;
          setSvgDimensions({
            width: svgWidth,
            height: svgHeight,
          });

          const startX = rectA.left - containerRect.left + rectA.width / 2 + startXOffset;
          const startY = rectA.top - containerRect.top + rectA.height / 2 + startYOffset;
          const endX = rectB.left - containerRect.left + rectB.width / 2 + endXOffset;
          const endY = rectB.top - containerRect.top + rectB.height / 2 + endYOffset;

          const controlPointX = startX + (endX - startX) / 2;
          const controlPointY = startY - curvature;

          const d = `M ${startX},${startY} Q ${controlPointX},${controlPointY} ${endX},${endY}`;
          setPathD(d);
        }
      };

      // Set up ResizeObserver
      const resizeObserver = new ResizeObserver(() => {
        updatePath();
      });

      // Observe the container and the from/to elements
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }
      if (fromRef.current) {
        resizeObserver.observe(fromRef.current);
      }
      if (toRef.current) {
        resizeObserver.observe(toRef.current);
      }

      // Initial update
      updatePath();

      return () => {
        resizeObserver.disconnect();
      };
    }, [
      containerRef,
      fromRef,
      toRef,
      curvature,
      startXOffset,
      startYOffset,
      endXOffset,
      endYOffset,
    ]);

    return (
      <svg
        ref={ref}
        className={cn(
          "pointer-events-none absolute left-0 top-0 transform-gpu stroke-2",
          className,
        )}
        width={svgDimensions.width}
        height={svgDimensions.height}
        viewBox={`0 0 ${svgDimensions.width} ${svgDimensions.height}`}
        style={{
          transform: "translateZ(0)",
        }}
      >
        <defs>
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={gradientStartColor} stopOpacity="0" />
            <stop offset="50%" stopColor={gradientStartColor} />
            <stop offset="100%" stopColor={gradientStopColor} stopOpacity="0" />
          </linearGradient>
        </defs>

        <path
          d={pathD}
          stroke={pathColor}
          strokeWidth={pathWidth}
          strokeOpacity={pathOpacity}
          fill="none"
        />
        <path
          d={pathD}
          strokeWidth={pathWidth}
          stroke={`url(#${gradientId})`}
          strokeOpacity="1"
          fill="none"
          strokeLinecap="round"
          strokeDasharray="30 200"
          style={{
            strokeDashoffset: animationDirection ? "-230" : "230",
            animationName: animationDirection ? "beam-reverse" : "beam",
            animationDuration: `${duration}s`,
            animationTimingFunction: "ease-in-out",
            animationIterationCount: "infinite",
            animationDelay: `${delay}ms`,
          }}
          onAnimationIteration={() => setAnimationDirection((prev) => !prev)}
        />

        <defs>
          <style>{`
            @keyframes beam {
              0% {
                stroke-dashoffset: 230;
              }
              50% {
                stroke-dashoffset: 0;
              }
              100% {
                stroke-dashoffset: -230;
              }
            }
            @keyframes beam-reverse {
              0% {
                stroke-dashoffset: -230;
              }
              50% {
                stroke-dashoffset: 0;
              }
              100% {
                stroke-dashoffset: 230;
              }
            }
          `}</style>
        </defs>
      </svg>
    );
  },
);

AnimatedBeam.displayName = "AnimatedBeam";
