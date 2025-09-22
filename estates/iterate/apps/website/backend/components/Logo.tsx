import { Link } from "./Link";
import logoAsset from "../assets/logo.svg?url";

interface LogoProps {
  width?: number;
  height?: number;
}

export default function Logo({ width, height }: LogoProps): React.ReactElement {
  return (
    <Link to="/" className="inline-block" variant="subtle">
      <img
        src={logoAsset}
        width={width ?? 40}
        height={height ?? 40}
        className="sm:w-[48px] sm:h-[48px]"
        alt="Iterate"
      />
    </Link>
  );
}
