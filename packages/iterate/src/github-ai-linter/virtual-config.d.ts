declare module "iterate:github-ai-linter-config" {
  const config: {
    policyVersion: string;
    rules: {
      glob: string;
      repoPath: string;
    };
  };

  export default config;
}
