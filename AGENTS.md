## Rebuild Roadmap

See @docs/rebuild-roadmap.md for the feature gap between `main` and this branch, and decisions about what to port, redesign, or drop.

## Git

Please don't use `git -C ...` because it makes it impossible for me to whitelist commands for you. Just be in the correct directory and do normal git operations. Please pass this instruction to any sub-agents you spawn.

## Bun

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

### Bun APIs (use these instead of their counterparts)

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests ONLY after you have checked the version of Git that is installed. If it is less than 2.40, use the `<command>:docker` alias for all `bun run` commands that have a docker alias. (See package.json).

GitHub integration is tested via **gh cassettes**: doc tests run the real `sp`
binary while replaying committed recordings in `tests/fixtures/cassettes/`, so the
default suite is offline and needs no auth. If you change code on the real-`gh`
path and need to re-validate it against GitHub, re-record the relevant cassette
with `SPRY_RECORD=1` (real-record mode is the validation - see
`tests/fixtures/cassettes/README.md`). Recording needs `gh` auth and an HTTPS git
config. (The lone live-network unit test shares the `SPRY_RECORD` gate, so it
runs alongside cassette recording and verifies the fixture reset machinery that
recording depends on.)

Every user-facing command or UI output must have doc-producing tests in a `tests/commands/<command>.doc.test.ts` file using the `docTest` helper from `tests/lib/index.ts`. Doc tests are the source of truth for generated documentation in `docs/generated/`. See `tests/commands/sync.doc.test.ts` or `tests/commands/view.doc.test.ts` for the pattern.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Changelog

You should edit the changelog after each change that affects runtime, BEFORE YOU COMMIT. This is a per-commit responsibility, not a release-time task. The release script handles changelog formatting automatically.

## Releasing

Use the release script to cut a new version. Do not manually edit any files - the script handles everything:

```bash
./scripts/release.sh <version>

# Example:
./scripts/release.sh 0.1.0-alpha.5
```

This will:

1. Validate the version format (semver with optional prerelease)
2. Update the changelog
3. Check that there are no uncommitted changes
4. Verify the version is newer than the latest tag (use `--force` to bypass)
5. Update `package.json` version
6. Commit the version bump
7. Create and push the git tag

The GitHub workflow automatically builds binaries for all platforms and creates a release with notes extracted from `CHANGELOG.md`.

**Version format:** `X.Y.Z` or `X.Y.Z-prerelease` (e.g., `0.1.0`, `0.1.0-alpha.4`, `1.0.0-beta.1`)

We are doing main development on the `rebuild-spry` branch. Split off and merge back to that branch for feature work.
