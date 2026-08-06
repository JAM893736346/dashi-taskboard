# Codex Taskboard Development Refresh Design

## Status

Approved in conversation on 2026-08-06. The user selected the hybrid refresh model for frequent development iteration: ordinary web builds refresh only the embedded iframe, while injector and host changes use an explicit runtime reload.

## Goal

Make completed web builds appear in an already-open Codex Taskboard without restarting Codex or rotating the resident injector on every build. Preserve a separate way to load injector and host-script changes without restarting the Codex application.

## Confirmed Operation Path

1. `npm run build` runs the Vite production build and writes `dist/web`.
2. The local service on `127.0.0.1:47823` serves the new bundle.
3. The build post-step discovers the loopback CDP port and the primary Codex renderer.
4. CDP invokes the injected `reloadFrame()` function.
5. `reloadFrame()` adds a new `__codex_taskboard_refresh` value to the iframe URL.
6. The already-open iframe requests the new production assets and displays the updated board.

The live path was demonstrated before implementation: the local service and CDP renderer were reachable, `npm run build` completed, and the iframe target changed to a cache-busted `http://127.0.0.1:47823/?host=codex&__codex_taskboard_refresh=...` URL without restarting Codex.

## Problem

The current build post-step uses `--refresh-if-running`. That mode first stops and replaces the resident injector, waits for startup-token and injected-source readiness, and only then reloads the iframe. Resident replacement is needed when Node host logic or the renderer injection script changes, but it is unnecessary for ordinary React and CSS builds.

Putting resident replacement on every build adds CDP renderer-readiness waits to the most frequent development path. A timeout in that independent host-runtime step prevents the subsequent iframe reload even when the freshly built URL is already healthy.

## Chosen Design

### Fast Web-Build Refresh

Add an iframe-only, best-effort injector mode named `--refresh-frame-if-running` and make `npm run build` use it.

This mode:

- discovers the same active CDP ports as the existing refresh commands;
- calls `refreshTaskboardFrames()` directly;
- does not call `restartResidentInjectorForRefresh()`;
- reports a skipped result and exits successfully when no debuggable Codex window is running; and
- keeps the existing cache-busted iframe reload behavior.

The resident injector PID must remain unchanged across `npm run build`.

### Explicit Runtime Reload

Keep the existing `--refresh-if-running` resident-replacement behavior and expose it as `npm run codex:reload`.

Use this command after changing:

- `inject/codex-taskboard.user.js`;
- `scripts/codex-injector.mjs`; or
- `scripts/codex-injector-runtime.mjs`.

The command replaces only the resident injector, reconciles the injected runtime, and refreshes the iframe. The Codex application process remains running.

The existing `npm run codex:refresh` remains the explicit iframe refresh that reports an error when no debuggable Codex renderer is available.

## Command Behavior

| Command | Iframe refresh | Resident injector replacement | No running Codex |
| --- | --- | --- | --- |
| `npm run build` | Yes, when available | No | Build succeeds with a skipped refresh |
| `npm run codex:refresh` | Yes | No | Command fails visibly |
| `npm run codex:reload` | Yes | Yes | Command exits successfully with a skipped result |

## Error Handling

- A missing Codex CDP endpoint must not fail an otherwise successful production build.
- A reachable Codex renderer refresh failure remains visible; the build must not silently claim that the embedded board updated.
- Runtime-reload readiness behavior remains unchanged in this request. It is isolated from the routine build path rather than broadened with new fallback behavior.

## Files

- `package.json`: route the build post-step to the fast mode and add `codex:reload`.
- `scripts/codex-injector.mjs`: parse the fast-mode flag and share the existing port discovery and frame-refresh branch without resident replacement.

No web application, server, persistence, cloud, or generated `dist/web` source file changes are required.

## Non-Goals

- No Vite HMR inside the production Codex iframe.
- No automatic file-type detection or filesystem watcher.
- No Codex application restart or patching of Codex internals.
- No redesign of resident startup readiness, renderer filtering, or host bindings.
- No new automated regression tests before the user confirms the direct development path works.

## Direct-Path Verification

1. Record the Codex application PID, resident injector PID, and current iframe URL.
2. Run `npm run build`.
3. Confirm the build succeeds, the Codex PID and resident injector PID are unchanged, and the iframe URL receives a new refresh token.
4. Run `npm run codex:reload`.
5. Confirm the resident injector PID changes, the Codex PID stays unchanged, and the iframe reloads successfully.
6. Run `git diff --check` and create one focused implementation commit after verification.
