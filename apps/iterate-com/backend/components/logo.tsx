import logoAsset from "../assets/logo.svg?url";
import { Link } from "./link.tsx";

interface LogoProps {
  width?: number;
  height?: number;
}

export default function Logo({ width, height }: LogoProps): React.ReactElement {
  return (
    <Link to="/" className="inline-flex" variant="none">
      <img src={logoAsset} width={width ?? 40} height={height ?? 40} alt="Iterate" />
    </Link>
  );
}
