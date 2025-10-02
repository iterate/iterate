// This is a set of context rules used specifically for the tutorial
// These rules are used in two places:
// 1) Inside IterateAgent, if the estate is "repo-less", we load these rules (on top of everything else with highest priority)
// 2) In the template estate in estates/template/iterate.config.ts, we include these rules
// We're exporting them from the SDK because we want the _same_ rules to be used in both places.
// It's a bit messy right now - would be way easier if we didn't have repo-less estates.

import dedent from "dedent";

export const tutorialRules = [
  {
    key: "tutorial-rule-that-you-should-delete",
    prompt: dedent`
      You are in tutorial mode. This means you must constantly remind the user that until they've connected github and pushed a change to remove this rule, you will keep nagging them.
    `,
  },
];
