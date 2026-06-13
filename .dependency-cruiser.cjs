/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  options: {
    tsPreCompilationDeps: true, // see type-only imports too
    tsConfig: { fileName: "tsconfig.json" }, // resolve NodeNext + .js specifiers
    doNotFollow: { path: "node_modules" },
    // dynamic import("./autostart.js") (the persistence→remote-transport seam) is followed by default
  },
  forbidden: [
    { name: "no-cycles", severity: "error", from: {}, to: { circular: true } },
    { name: "core-is-leaf", severity: "error", from: { path: "^src/core/" }, to: { pathNot: "^src/core/" } },
    { name: "platform-only-core", severity: "error", from: { path: "^src/platform/" }, to: { path: "^src/(infrastructure|application|apps)/" } },
    { name: "infra-no-up", severity: "error", from: { path: "^src/infrastructure/" }, to: { path: "^src/(application|apps)/" } },
    { name: "infra-no-sibling", severity: "error", from: { path: "^src/infrastructure/(?!remote-transport/)([^/]+)/" }, to: { path: "^src/infrastructure/(?!remote-transport/)(?!$1/)[^/]+/" } },
    { name: "app-no-up", severity: "error", from: { path: "^src/application/" }, to: { path: "^src/apps/" } },
    { name: "app-no-sibling", severity: "error", from: { path: "^src/application/([^/]+)/" }, to: { path: "^src/application/(?!$1/)[^/]+/" } },
    { name: "apps-no-sibling", severity: "error", from: { path: "^src/apps/([^/]+)/" }, to: { path: "^src/apps/(?!$1/)[^/]+/" } },
    { name: "no-orphans", severity: "error", from: { orphan: true, pathNot: "\\.d\\.ts$" }, to: {} },
  ],
};
