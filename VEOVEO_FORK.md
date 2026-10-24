# VeoveoAI Fork

This fork carries Veoveo changes on `main` over upstream OpenCode
(`upstream` = `https://github.com/anomalyco/opencode`, branch `dev`).

- Current upstream base: `63c1a27` (2026-10-17).
- Update this file whenever a fork change is added, changed or retired.

## Updating To Latest Upstream

1. Fetch `upstream` and replay the Veoveo changes below onto `upstream/dev` in a new
   worktree branch.
2. For each item, first check whether upstream now provides equivalent behavior. If
   it does, drop our change and record that here.
3. Resolve conflicts by intent: keep what is listed under "Carried", keep removed what
   is listed under "Removed". Do not restore removed code just because a conflict
   touches it.
4. Run each item's check, then typecheck the touched packages (`bun run typecheck`).
5. Update the upstream base SHA above.

Known baseline test failures at `ed62aad`, before the removals below; they are
unrelated to fork changes:

- app: `src/runtime/server/global-sync/bootstrap.test.ts` ("recovers project metadata
  after the connection to the server is dropped")
- tui: 7 tests in `test/plugin-source.test.ts` and `test/plugin-keymap.test.tsx`

## Toolchain

- `package.json` pins Bun through `packageManager` (`bun@1.4.2` at this base). Re-read it
  after every upstream update.
- The husky pre-push hook rejects a Bun older than the pin, then runs `bun run check`.
  Do not bypass it with `--no-verify`.
- On the Mac, the default `~/.bun/bin/bun` is 1.3.13 (2026-10-20). Pushing from this
  checkout fails until the pinned Bun comes first on `PATH`. Either:
  - **Machine-wide:** `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"`. This
    changes Bun for every project on the Mac, so ask the user first.
  - **Per session:**
    1. Download `bun-darwin-aarch64.zip` and `SHASUMS256.txt` from
       `https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2` into an empty temporary
       directory.
    2. Verify the zip with `grep " bun-darwin-aarch64.zip$" SHASUMS256.txt | shasum -a 256 -c -`.
    3. Unzip it, then push with `PATH="<dir>/bun-darwin-aarch64:$PATH" git push origin main`.
- After switching Bun, run `bun install --frozen-lockfile` if workspace links are stale.
  It changes no source or lock files.
- The Linux build host builds with the pinned Bun.

## Carried

### MCP Tasks (`46b2429`, `7b12c60`)

- Native modern MCP Tasks execution in `packages/core/src/mcp/client.ts` and
  `task-client.ts`, tested in `packages/core/test/mcp-tasks.test.ts`.
- Bumps `@modelcontextprotocol/*` to 2.3.1 and adds `@modelcontextprotocol/ext-tasks`.
- Carries `patches/@modelcontextprotocol%2Fclient@2.3.1.patch`, which closes HTTP task
  subscriptions without cancel notifications.
- On update: if upstream adopts Tasks or a newer SDK, re-check whether the client patch
  is still needed, then rerun `mcp-tasks.test.ts`.

### Reopened MCP List-Changed Subscription (`d8cf312`)

- `packages/core/src/mcp/client.ts` reopens the SDK's auto-opened `subscriptions/listen`
  subscription after any close but its own (a server restart or a proxy that drops the
  stream), backing off to every 30 s, then reloads the lists it covers.
- On a Computer, the sandbox proxy closes every L7 tunnel when a provider credential
  refresh publishes a new policy generation, so without this the Hub's list-changed
  notifications stopped after the first refresh.
- On update: if upstream or a newer SDK reopens the subscription itself, drop this and
  keep the test `reopens a list-changed subscription whose stream the transport dropped`
  in `packages/core/test/mcp.test.ts`.

### Hosted Browser Mount Behind A Trusted Proxy (`376324a`, `4bd4891`, `ed62aad`)

- `opencode serve --trusted-local-proxy --base-path <path>`: the authenticated proxy
  owns admission, and the browser app is served under a private mount path.
- Touches `packages/server/src/options.ts` and `process.ts`, plus base-path handling in
  util, cli and app.
- `4bd4891` normalizes the mounted router base; `ed62aad` keeps titlebar history inside
  the mount.
- The Computer image command depends on these flags.
- On update: run `packages/server/test/process.test.ts`, `packages/util/test/base-path.test.ts`
  and `packages/app/test-browser/pwa-route.test.ts`.

## Removed

Decision (2026-10-20): OpenCode does no version control. The agent uses the native
Lore CLI, and Lore owns history and undo.

### Undo, Redo And Message Revert UI

Removed:

- Web app:
  - the `/undo` and `/redo` commands (`app/src/session/commands/use-session-commands.tsx`);
  - the per-message "Revert message" action: `app/src/session/composer/region.tsx` no
    longer passes `revert` in the timeline actions;
  - `app/src/session/revert.ts`.
- TUI:
  - the `session.undo` and `session.redo` commands, and the "N messages reverted …
    /redo to restore" banner (`tui/src/routes/session/index.tsx`);
  - the "Revert" option in `dialog-message.tsx`, and the now-unused `setPrompt` prop
    through `dialog-timeline.tsx`;
  - the `session.undo`/`session.redo` keybinds (`tui/src/config/keybind.ts`) and their
    v1 aliases `messages_undo`/`messages_redo` (`tui/src/config/v1/keybind.ts`).

Kept on purpose:

- The server revert API, including the composer committing an already-staged revert on
  submit.
- `session-ui`'s message component, which only shows a revert button when an action is
  supplied.
- `/fork`, and desktop Edit → Undo (text editing).
- i18n strings and upstream website docs.

Guard: the "revert" block in `app/e2e/regression/session-header.spec.ts` asserts there
is no revert button and no `/undo` or `/redo` suggestion.

On update: `rg "revert\.(stage|clear)" packages/app packages/tui packages/session-ui`
must find no client callers. Any new caller is a new entry point to remove.

### "Create Git Repository" In The Review Panel

Removed:

- `session-ui/src/v2/components/session-review-empty-no-git-v2.tsx` shows only "No
  tracked changes": no button, no git/undo pitch.
- `gui-extensions/src/review/model.ts` no longer has `initializeGit`.
- `parts.tsx` renders the empty state without props.

On update: `rg "vcs\.init|provider: \"git\"" packages/app packages/gui-extensions packages/tui`
must find no client callers.

## Configuration Instead Of Code

These live in `veoveo-template-installation/computer/opencode.json`, not in this fork:

- `"plugins": ["-opencode.vcs.git", "-opencode.vcs.hg", ...]` removes the built-in VCS
  providers, using the native plugin remove directive.
- The same list removes `opencode.provider.ollama`, `opencode.provider.lmstudio` and
  `opencode.provider.vllm`, which otherwise probe loopback model servers every 30 s.
- `"snapshots": false` turns off turn snapshots.

On update: confirm the IDs `opencode.vcs.git`/`opencode.vcs.hg` (`packages/core/src/plugin/vcs/`),
the three provider IDs (`packages/core/src/plugin/provider/`) and the `snapshots` key
(`packages/schema/src/config.ts`) still exist. A renamed ID silently stops matching.

## Git Paths Intentionally Left In Core

These stay dormant while no `.git` exists at or above the workspace:

- project discovery (`core/src/project.ts`);
- the `.git/HEAD` watcher (`core/src/filesystem/location-watcher.ts`);
- the git worktree strategy and the agent `worktree_*` tools;
- git-backed snapshots and the git reference cache;
- the "Is directory a git repo" environment line;
- the `/review` command template;
- git mentions in system prompts.

Revisit them if a Computer workspace can contain `.git`.

## Not Done (Decided)

- No Lore VCS provider, no `.lore` detection, no Lore-backed snapshots.
- If wanted later, follow the Mercurial pattern: marker detection in
  `core/src/project.ts` plus a provider plugin under `core/src/plugin/vcs/`.
