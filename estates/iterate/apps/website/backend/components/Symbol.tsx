import symbolAsset from "../assets/symbol.svg?url";

const SymbolIcon = ({ ...rest }) => {
  return (
    <img src={symbolAsset} alt="Iterate" className="relative iterate-symbol w-6 h-6" {...rest} />
  );
};

export default SymbolIcon;
