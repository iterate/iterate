import { defineConfig } from "react-doctor/api";

export default defineConfig({
  rules: {
    // The whole editor graph sits behind this package's `/editor` entry,
    // which both vessel apps load with React.lazy() — so the "eager"
    // @codemirror imports these modules make never reach an eager bundle.
    // The code-split point is the package boundary, not each module.
    "react-doctor/prefer-dynamic-import": "off",
  },
});
