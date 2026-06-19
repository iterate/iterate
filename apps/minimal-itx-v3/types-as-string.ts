// codegen:start {preset: str, source: "./tsconfig.json", const: theTypes, export: true}
export const theTypes =
  '{\n  "compilerOptions": {\n    "target": "ESNext",\n    "module": "ES2022",\n    "moduleResolution": "bundler",\n    "lib": ["ESNext", "ESNext.Disposable"],\n    "strict": true,\n    "skipLibCheck": true,\n    "noEmit": true,\n    "esModuleInterop": true,\n    "allowImportingTsExtensions": true,\n    "verbatimModuleSyntax": false\n  },\n  // Worker program only. Node-side client/test/script files are checked by\n  // tsconfig.node.json.\n  "include": ["src/worker.ts", "worker-configuration.d.ts"],\n  "exclude": ["src/client.ts", "src/examples/**/*.ts", "src/**/*.test.ts"]\n}\n';
// codegen:end
