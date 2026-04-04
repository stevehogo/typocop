---
trigger: always_on
---

# Package Manager

Always use `pnpm` for all package management commands in this project.

- Install dependencies: `pnpm install`
- Add a package: `pnpm add <package>`
- Add a dev dependency: `pnpm add -D <package>`
- Remove a package: `pnpm remove <package>`
- Run scripts: `pnpm run <script>` or `pnpm <script>`

Never use `npm` or `yarn` commands.