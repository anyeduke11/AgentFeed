# Repository Guidelines

## Project Structure & Module Organization
AgentFeed is an npm workspace with two packages. `server/` contains the Express, SQLite, scanner, reader, LLM queue, and MCP code; route handlers live in `server/src/routes/`, shared backend logic in `server/src/`, and backend tests in `server/test/*.test.ts`. `web/` contains the Vue 3 + Vite dashboard; views are in `web/src/views/`, state stores in `web/src/stores/`, reusable UI in `web/src/components/`, and global styles in `web/src/styles/main.css`. Product and architecture notes live in `docs/`. Local runtime data, logs, archives, and generated packages should stay out of commits.

## Build, Test, and Development Commands
- `npm install`: install root workspace dependencies.
- `./service.sh start`: build missing artifacts and run the local dashboard on `127.0.0.1:5188`.
- `./service.sh restart`: rebuild both packages and restart the service.
- `npm run dev -w server`: run the backend with `tsx watch`.
- `npm run dev -w web`: run the Vite frontend during UI work.
- `npm run build -w web`: run `vue-tsc` type checks and create the frontend build.
- `npm test -w server`: run all backend `node:test` suites.
- `npm run db:migrate`: apply idempotent SQLite migrations from the server package.

## Coding Style & Naming Conventions
Use TypeScript ES modules, single quotes, no semicolons, and two-space indentation. Keep Express routers small and place new API surfaces under `server/src/routes/`. Frontend components use PascalCase `.vue` files, Pinia stores use `useXStore.ts`, and route/view filenames should match their visible feature area. Preserve the API response shape `{ success: boolean, ... }` and prefer named exports where existing files do.

## Testing Guidelines
Backend tests use Node's built-in test runner through `tsx --test`. Add tests beside related suites in `server/test/`, named `feature.test.ts`. Always run targeted tests for reader sanitization, scanning, rule scoring, embeddings, gate behavior, or LLM provider changes; run `npm test -w server` before PRs touching shared backend logic.

## Commit & Pull Request Guidelines
History currently follows Conventional Commit style, for example `feat: AgentFeed v0.1.0 ...`. Use `feat:`, `fix:`, `docs:`, `refactor:`, or `test:` with a concise imperative summary. PRs should explain user-visible impact, list validation commands, link related issues or docs, and include screenshots or screen recordings for dashboard UI changes.

## Security & Configuration Tips
Keep API keys, SQLite files, scan roots, and `.service.log` local. Disk-reading endpoints must validate paths stay inside enabled scan roots. Reader changes must preserve server-side sanitization plus iframe sandboxing without script execution.
