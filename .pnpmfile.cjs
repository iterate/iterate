const REMOVED_BETTER_AUTH_DEPENDENCIES = [
  "@better-auth/drizzle-adapter",
  "better-sqlite3",
  "drizzle-kit",
  "drizzle-orm",
];

function removeDependencyNames(dependencies) {
  for (const name of REMOVED_BETTER_AUTH_DEPENDENCIES) {
    delete dependencies?.[name];
  }
}

module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name !== "better-auth") return pkg;

      removeDependencyNames(pkg.dependencies);
      removeDependencyNames(pkg.optionalDependencies);
      removeDependencyNames(pkg.peerDependencies);
      removeDependencyNames(pkg.peerDependenciesMeta);

      return pkg;
    },
  },
};
