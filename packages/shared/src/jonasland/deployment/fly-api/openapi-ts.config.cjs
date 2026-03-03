/** @type {import('@hey-api/openapi-ts').UserConfig} */
module.exports = {
  input: "./src/jonasland/deployment/fly-api/openapi/openapi3.yaml",
  output: {
    path: "./src/jonasland/deployment/fly-api/generated",
    clean: true,
  },
  plugins: [
    {
      name: "@hey-api/typescript",
    },
    {
      name: "@hey-api/client-fetch",
    },
    {
      name: "@hey-api/sdk",
    },
  ],
};
