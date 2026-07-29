declare module "iterate:github-ai-linter-config" {
  const config: {
    policyVersion: string;
    rules: {
      paths: string[];
      repoPath: string;
    };
  };

  export default config;
}
