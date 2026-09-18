export default {
  root: import.meta.dirname,
  test: { include: ["lifecycle.test.ts"], retry: 0, environment: "node" },
};
