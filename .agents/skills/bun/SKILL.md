---
name: Bun
description: Use when building JavaScript/TypeScript applications, setting up HTTP servers, managing dependencies, bundling code, running tests, or working with full-stack applications. Bun is a complete JavaScript runtime, package manager, bundler, and test runner that replaces Node.js, npm, and other tools.
metadata:
    mintlify-proj: bun
    version: "1.0"
---

# Bun Skill

## Product summary

Bun is a complete JavaScript runtime, package manager, bundler, and test runner written in Zig. It replaces Node.js, npm, yarn, esbuild, and Jest with a single fast binary. Use Bun to run TypeScript/JSX directly, install dependencies, bundle applications, and run tests. Key files: `bunfig.toml` (configuration), `package.json` (dependencies), `bun.lock` (lockfile). Primary CLI commands: `bun run`, `bun install`, `bun build`, `bun test`. See https://bun.com/docs for complete documentation.

## When to use

Reach for this skill when:
- **Running code**: Execute JavaScript, TypeScript, or JSX files directly without compilation steps
- **Managing dependencies**: Install, add, remove, or update npm packages faster than npm/yarn/pnpm
- **Building applications**: Bundle JavaScript/TypeScript for browsers, Node.js, or Bun runtime
- **Testing**: Write and run Jest-compatible tests with built-in test runner
- **Starting servers**: Create HTTP servers with `Bun.serve()` for APIs, full-stack apps, or WebSockets
- **File I/O**: Read/write files, streams, and binary data with optimized APIs
- **Monorepos**: Manage workspaces with isolated or hoisted dependency linking
- **Full-stack development**: Bundle HTML imports to serve frontend and backend from single executable

## Quick reference

### Essential commands

| Task | Command |
|------|---------|
| Run a file | `bun run index.ts` or `bun index.ts` |
| Run a script | `bun run dev` (from package.json) |
| Install dependencies | `bun install` |
| Add a package | `bun add react` or `bun add -d @types/node` |
| Remove a package | `bun remove react` |
| Run tests | `bun test` |
| Build/bundle | `bun build ./index.ts --outdir ./dist` |
| Watch mode | `bun --watch run index.ts` or `bun build --watch` |
| Create project | `bun init my-app` |

### Configuration file: bunfig.toml

Located at project root or `~/.bunfig.toml`. Optional but useful for:

```toml
[install]
linker = "hoisted"  # or "isolated" for monorepos
optional = true
dev = true
peer = true

[test]
coverage = false
timeout = 5000

[run]
shell = "system"  # or "bun" on Windows
bun = true        # alias node to bun in scripts

[serve]
port = 3000
```

### File type support

Bun transpiles on-the-fly:
- `.js`, `.jsx`, `.ts`, `.tsx` — JavaScript/TypeScript with JSX
- `.json`, `.jsonc`, `.toml`, `.yaml` — Parsed at build time
- `.html` — Full-stack bundling with asset processing
- `.css` — Bundled into single file
- `.wasm`, `.node` — Supported as assets

### Common patterns

**HTTP server:**
```ts
Bun.serve({
  port: 3000,
  routes: {
    "/": () => new Response("Hello"),
    "/api/users/:id": req => new Response(`User ${req.params.id}`),
  },
});
```

**Read/write files:**
```ts
const file = Bun.file("path.txt");
const text = await file.text();
await Bun.write("output.txt", "content");
```

**Test:**
```ts
import { test, expect } from "bun:test";
test("math", () => expect(2 + 2).toBe(4));
```

**Bundle:**
```ts
await Bun.build({
  entrypoints: ["./index.tsx"],
  outdir: "./dist",
  minify: true,
});
```

## Decision guidance

| Scenario | Use | Why |
|----------|-----|-----|
| **Dependency linking** | `linker = "hoisted"` | Traditional npm behavior, simpler for single packages |
| **Dependency linking** | `linker = "isolated"` | Prevents phantom dependencies, required for monorepos |
| **Package manager** | `bun install` | 25x faster than npm, compatible with existing projects |
| **Bundler target** | `target: "browser"` | Client-side code, prioritizes browser exports |
| **Bundler target** | `target: "bun"` | Server code, optimized for Bun runtime |
| **Bundler target** | `target: "node"` | Node.js compatibility, outputs `.mjs` |
| **Test execution** | `--concurrent` | Independent async tests, faster suites |
| **Test execution** | `test.serial` | Tests with shared state or order dependencies |
| **HTTP handler** | `routes` object | Simple routing, static/dynamic routes |
| **HTTP handler** | `fetch` function | Complex logic, middleware, custom routing |
| **File I/O** | `Bun.file()` + `Bun.write()` | Optimized for Bun, recommended approach |
| **File I/O** | `node:fs` module | Operations not yet in Bun API (mkdir, readdir) |

## Workflow

### Running a TypeScript project

1. **Check project structure**: Verify `package.json` exists and lists dependencies
2. **Install dependencies**: Run `bun install` (creates `bun.lock`)
3. **Run code**: Execute `bun run index.ts` or `bun run <script>` from package.json
4. **Watch for changes**: Add `--watch` flag for development: `bun --watch run dev`
5. **Verify output**: Check console for errors or expected behavior

### Building for production

1. **Review source**: Identify entry points and dependencies
2. **Configure build**: Create `bunfig.toml` or pass CLI flags for minification, target, format
3. **Run build**: `bun build ./src/index.ts --outdir ./dist --minify`
4. **Check output**: Verify bundled files in `./dist` directory
5. **Test bundle**: Run the bundled code to confirm it works
6. **Deploy**: Upload dist folder or compiled executable to production

### Setting up HTTP server

1. **Create handler**: Write `Bun.serve()` with `fetch` or `routes`
2. **Configure port**: Set `port` in options or via `BUN_PORT` env var
3. **Add routes**: Define static/dynamic routes or use `fetch` for custom logic
4. **Test locally**: Run `bun run server.ts` and visit `http://localhost:3000`
5. **Add middleware**: Wrap routes with auth, logging, or error handling as needed
6. **Deploy**: Use `bun build --compile` for standalone executable or deploy source

### Writing and running tests

1. **Create test file**: Name it `*.test.ts` or `*.spec.ts`
2. **Import test utilities**: `import { test, expect, describe } from "bun:test"`
3. **Write tests**: Use `test()` for individual tests, `describe()` for grouping
4. **Run tests**: Execute `bun test` to discover and run all test files
5. **Filter tests**: Use `bun test --test-name-pattern add` to run specific tests
6. **Watch mode**: Add `--watch` for re-running on file changes
7. **Check coverage**: Run `bun test --coverage` to see coverage reports

## Common gotchas

- **Shebang in scripts**: Bun respects `#!/usr/bin/env node` shebangs; use `bun run --bun` to force Bun execution instead
- **Auto-install disabled in production**: Set `install.auto = "disable"` in bunfig.toml for CI/CD to prevent runtime package resolution
- **Lockfile format**: Bun uses `bun.lock` (text) by default since v1.2; old `bun.lockb` (binary) must be migrated
- **TypeScript errors in Bun global**: Install `@types/bun` and add `"lib": ["ESNext"]` to tsconfig.json
- **Lifecycle scripts security**: Bun doesn't run postinstall scripts by default; add packages to `trustedDependencies` in package.json to allow them
- **Peer dependencies**: Bun installs peer dependencies by default (unlike npm); use `--omit peer` to skip them
- **Watch mode flag placement**: Put Bun flags immediately after `bun`: `bun --watch run dev` ✓, not `bun run dev --watch` ✗
- **Bundler not for type-checking**: Use `tsc` separately for type checking; Bun's bundler transpiles but doesn't validate types
- **Minification by default for Bun target**: When `target: "bun"`, identifiers are minified automatically; disable with `minify: false`
- **External imports in bundles**: Mark packages as external to exclude them: `external: ["lodash"]` leaves import statement in bundle
- **Idle timeout on streams**: `Bun.serve` closes idle connections after 10 seconds; disable per-request with `server.timeout(req, 0)` for SSE/long-polling

## Verification checklist

Before submitting work with Bun:

- [ ] Dependencies installed: `bun install` completed without errors
- [ ] Code runs: `bun run <file>` executes without crashing
- [ ] Tests pass: `bun test` shows all tests passing (or expected failures)
- [ ] No TypeScript errors: Check for red squiggles in editor (install `@types/bun` if needed)
- [ ] Bundler output valid: `bun build` produces files in output directory
- [ ] HTTP server responds: `Bun.serve` starts and responds to requests on configured port
- [ ] Lockfile committed: `bun.lock` is in version control for reproducible installs
- [ ] bunfig.toml valid: TOML syntax is correct (use online validator if unsure)
- [ ] No deprecated patterns: Avoid `bun.lockb`, old Node.js-only APIs, or manual transpilation
- [ ] Environment variables set: Required vars (API keys, ports) are available at runtime

## Resources

- **Comprehensive navigation**: https://bun.com/docs/llms.txt — Full page-by-page listing for agent reference
- **Runtime API**: https://bun.com/docs/runtime/index — Execute files, run scripts, environment variables
- **Package manager**: https://bun.com/docs/pm/cli/install — Install, add, remove packages; workspaces
- **Bundler**: https://bun.com/docs/bundler/index — Bundle JavaScript/TypeScript; full-stack apps
- **Test runner**: https://bun.com/docs/test/index — Jest-compatible testing with mocks, snapshots, coverage
- **HTTP server**: https://bun.com/docs/runtime/http/server — `Bun.serve()`, routing, WebSockets, TLS

---

> For additional documentation and navigation, see: https://bun.com/docs/llms.txt