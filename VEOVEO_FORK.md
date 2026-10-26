# VeoveoAI Fork

This fork carries Veoveo changes on `main` over upstream OpenCode
(`upstream` = `https://github.com/anomalyco/opencode`, branch `dev`).

- Current upstream base: `a697f53` (2026-10-26), after upstream merged its 2.0 line and
  beta into `dev`. Previous base: `63c1a27` (2026-10-17); see "Update Log".
- Update this file whenever a fork change is added, changed or retired.

## Updating To Latest Upstream

1. Fetch `upstream` and replay the Veoveo changes below onto `upstream/dev` in a new
   worktree branch.
2. For each item, first check whether upstream now provides equivalent behavior. If
   it does, drop our change and record that here.
3. Resolve conflicts by intent: keep what is listed under "Carried", keep removed what
   is listed under "Removed". Do not restore removed code just because a conflict
   touches it.
4. Run each item's check, then typecheck the touched packages (`bun run typecheck`, and
   `bun run typecheck:tsc`, which CI uses and which wins when the two disagree).
5. Update the upstream base SHA above.

Known test failures at `a697f53`, unrelated to fork changes:

- cli: `test/stats.test.ts` ("uses the OpenCode palette in color mode") fails when the
  calling terminal sets `COLORFGBG` (the Mac's terminal sets `15;0`); it passes under
  `env -u COLORFGBG`.
- tui: `test/component/go-upsell-art.test.tsx` ("the art stops every frame when hidden,
  closed, or still, …") fails on every run.
- core: 7 shell tests on the Mac, in `test/tool-shell.test.ts` (ShellTool "conditional
  process substitution" and "compound syntax approval compatibility") and
  `test/shell-scan/compound-parity.test.ts` ("real-shell compound syntax"); the Mac's
  `/bin/bash` is 3.2.57.

Each fails the same way on an unmodified `a697f53` checkout.

The `ed62aad` baseline failures no longer reproduce at `a697f53`: app
`bootstrap.test.ts` passes, and so do tui `test/plugin-source.test.ts` and
`test/plugin-keymap.test.tsx`.

## Toolchain

- `package.json` pins Bun through `packageManager` (`bun@1.4.4` at this base; it was
  `1.4.2` at `63c1a27`). Re-read it after every upstream update.
- The husky pre-push hook rejects a Bun older than the pin, then runs `bun run check`.
  Do not bypass it with `--no-verify`.
- On the Mac, the default `~/.bun/bin/bun` is 1.3.13 (2026-10-20). Pushing from this
  checkout fails until the pinned Bun comes first on `PATH`. Either:
  - **Machine-wide:** `curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"`. This
    changes Bun for every project on the Mac, so ask the user first.
  - **Per session:**
    1. Download `bun-darwin-aarch64.zip` and `SHASUMS256.txt` from
       `https://github.com/oven-sh/bun/releases/tag/bun-v1.4.4` into an empty temporary
       directory.
    2. Verify the zip with `grep " bun-darwin-aarch64.zip$" SHASUMS256.txt | shasum -a 256 -c -`.
    3. Unzip it, then push with `PATH="<dir>/bun-darwin-aarch64:$PATH" git push origin main`.
- After switching Bun, run `bun install --frozen-lockfile` if workspace links are stale.
  It changes no source or lock files.
- The Linux build host builds with the pinned Bun, kept per version in
  `~/.local/share/bun-<version>-linux-x64/bin/bun` (`bun-linux-x64.zip`, verified against
  the release's `SHASUMS256.txt` the same way).

## Carried

### MCP Tasks (`46b2429`, `7b12c60`)

- Native modern MCP Tasks execution in `packages/core/src/mcp/client.ts` and
  `task-client.ts`, tested in `packages/core/test/mcp-tasks.test.ts`.
- Upstream moved `@modelcontextprotocol/*` to 2.3.1 itself (`096c2ba`); the fork adds
  only `@modelcontextprotocol/ext-tasks` 0.2.2 to `packages/core`.
- `patches/@modelcontextprotocol%2Fclient@2.3.1.patch` is shared with upstream. Upstream's
  hunks (OAuth metadata discovery and authorization URL, loose tool `outputSchema`) stay;
  the fork adds: Streamable HTTP subscriptions close without `notifications/cancelled`, a
  malformed `subscriptions/listen` acknowledgement fails the listen, and the subscription
  filter accepts extension keys such as `taskIds`. On a conflict, merge the hunks; do not
  take either side whole.
- `TaskClient` is the base class of upstream's `ToolCheckingClient`, which drops malformed
  tools from `tools/list`.
- Task input requests (elicitation) run with the connection's Effect context, as
  upstream's ordinary elicitation does since `889abb4`, so their form events keep the
  server's Location.
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
- Upstream's Basic auth username (`OPENCODE_SERVER_USERNAME`) shares the server auth
  config with the mount's `basePath`; with `--trusted-local-proxy` there is no password,
  so it is unused.
- `4bd4891` normalizes the mounted router base; `ed62aad` keeps titlebar history inside
  the mount.
- The Computer image command depends on these flags.
- On update: run `packages/server/test/process.test.ts`, `packages/util/test/base-path.test.ts`,
  `packages/app/test-browser/pwa-route.test.ts`, and in `packages/cli`
  `test/trusted-local-proxy.test.ts` and `test/web-ui.test.ts`. Also confirm the `serve`
  flags in `packages/cli/src/commands/commands.ts` against the Computer image's `CMD`.

## Removed

Decision (2026-10-20): OpenCode does no version control. The agent uses the native
Lore CLI, and Lore owns history and undo.

### Undo, Redo And Message Revert UI

Removed:

- Web app:
  - the `/undo` and `/redo` commands (`app/src/session/commands/use-session-commands.tsx`);
  - the per-message rewind action, "Rewind to here" since upstream `6a49548` (it was
    "Revert message"): `app/src/session/composer/region.tsx` no longer passes `revert` in
    the timeline actions;
  - in `app/src/session/revert.ts`, rewinding with its Undo toast, `undo` and `redo`. The
    file keeps only upstream's `recall` (`5c3891e`), which puts a sent prompt back in the
    composer without rewinding the Session after a free-tier limit stops it.
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
- `/fork`, the per-message "Fork from here" action, and desktop Edit → Undo (text
  editing).
- The TUI's `queued_prompt.undo`, which withdraws a prompt that has not been delivered
  yet (an inbox cancel), not history.
- i18n strings and upstream website docs.

Guard: the "revert" block in `app/e2e/regression/session-header.spec.ts` asserts that a
user message shows "Fork from here" but no "Rewind to here", and that there is no `/undo`
or `/redo` suggestion.

On update: `rg "revert\.(stage|clear)" packages/app packages/tui packages/session-ui`
must find no client callers. Any new caller is a new entry point to remove. At `a697f53`
it matches only the event names `session.revert.staged` and `session.revert.cleared` (an
event list in `app/src/runtime/server/data.ts` and a TUI test fixture).

### "Create Git Repository" In The Review Panel

Removed:

- `session-ui/src/v2/components/session-review-empty-no-git-v2.tsx` shows only "No
  tracked changes": no button, no git/undo pitch.
- `gui-extensions/src/review/model.ts` no longer has `initializeGit`.
- `parts.tsx` renders the empty state without props.

On update: `rg "vcs\.init|provider: \"git\"" packages/app packages/gui-extensions packages/tui`
must find no client callers. At `a697f53`, as at `63c1a27`, it matches only
`app/e2e/regression/review.spec.ts`, an upstream e2e that still expects the removed
initialization request. Its four Git initialization cases fail against the fork because
the button is gone; replacing them with a guard like the revert one is not done yet.

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
Then decode the Computer's `opencode.json` with `Config.Info` and
`onExcessProperty: "error"` from `packages/schema`, so a renamed key fails instead of
being dropped.

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

## Update Log

### 2026-10-26: `63c1a27` → `a697f53` (branch `update-2026-10-26`)

Upstream `dev` had merged its 2.0 line and beta (436 first-parent commits). Replayed the 11
commits `46b2429`…`ea6f7c1`. `e7821a7` and `59ea8a0` and their reverts `ad5d2da` and
`35659fe` cancel out, so they were not replayed. No item was dropped: upstream has no
Tasks support, no list-changed reopen and no trusted proxy or base path.

- MCP Tasks: adapted. The SDK bump collapses to adding `ext-tasks`; the client patch is
  merged hunk by hunk with upstream's; `ToolCheckingClient` extends `TaskClient`; Task
  elicitation uses the connection's context. `mcp-tasks.test.ts`: 21 pass.
- List-changed reopen: kept, on upstream's per-server `timeout`. `mcp.test.ts` with
  `mcp-tasks.test.ts`: 96 pass.
- Hosted mount: adapted to upstream's username in the auth config, its relocated auth
  construction (`Option.fromNullishOr(password)`), `createServerTransport` and i18n
  imports. Server `process.test.ts` 5, util `base-path.test.ts` 1, app `pwa-route.test.ts`
  8, cli `trusted-local-proxy.test.ts` and `web-ui.test.ts` 8: all pass. `serve` flags
  are unchanged upstream (`--hostname`, `--port`, `--cors`, `--service`, `--stdio`).
- Undo, redo and revert UI: kept removed, adapted to upstream's rewind (`6a49548`):
  `revert.ts` keeps only `recall`, upstream's rewind e2e cases were dropped with it, the
  guard targets "Rewind to here". Guard e2e (`session-header.spec.ts` "revert"): 2 pass.
- Create Git repository: kept removed. Its guard grep matches only the e2e above.
- Configuration: plugin IDs and `snapshots` present; the Computer's `opencode.json`
  decodes strictly.
- Platform API on the Computer's loopback: request shapes of `POST /api/session`,
  `POST /api/session/{id}/prompt`, `POST /api/experimental/session/{id}/wait` and the
  `limit`, `order` and `cursor` of `GET /api/session/{id}/message` are unchanged.
  `GET /api/model` takes an optional `types` filter and lists only `chat` models without
  it; models gain `type`. In message bodies the opaque provider state becomes `native`
  (assistant and compaction `providerState`, text and reasoning part `state`, tool part
  `providerState` and `providerResultState`; a tool part's own `state` stays), compaction
  drops `recent` and `providerContext`, and errors gain `retryAfterMs`. The wait route's
  404 is only `SessionNotFoundError`.
- Checks: `bun run check` and `bun run typecheck:tsc` pass. Suites: server 107, cli 350
  (1 known), util 136, ui 315, session-ui 313, gui-extensions 244, app unit 898, app
  browser 235, tui 1553 (1 known), core 6903 (7 known).
