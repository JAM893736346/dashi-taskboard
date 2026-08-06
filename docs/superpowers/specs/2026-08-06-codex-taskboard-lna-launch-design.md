# Codex Taskboard Local Network Access Launch Design

## Status

Approved in conversation on 2026-08-06. The user accepted one complete Codex restart when adopting the fix; subsequent web builds must continue to refresh only the embedded Taskboard iframe.

## Goal

Keep the local Taskboard iframe usable inside Codex after every production web build. A completed build must reload the embedded board in place rather than ending on the 12-second `Taskboard page load timeout` state.

## Confirmed Operation Path

1. `npm run build` writes the new web bundle and invokes the iframe-only refresh mode.
2. The injector calls the renderer injection's `reloadFrame()` function.
3. `reloadFrame()` creates a cache-busted iframe navigation to `http://127.0.0.1:47823/?host=codex`.
4. Chrome 151 classifies the Codex `app://-` renderer as public and blocks its navigation to the loopback address with `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`.
5. The Taskboard React document never starts, so it never sends `taskboard:ready`.
6. The host-side ready waiter expires after 12 seconds and displays the timeout state shown by the user.

Live CDP inspection confirmed that the failed iframe document was `chrome-error://chromewebdata/`, had no React root, and contained the Local Network Access block message. An isolated Chromium launch with `--disable-features=LocalNetworkAccessChecks` received HTTP 200 for the same Taskboard iframe document request.

## Considered Approaches

### Taskboard-Scoped Codex Launch Flag (Chosen)

Add `--disable-features=LocalNetworkAccessChecks` to the arguments used by `launchCodex()`.

This is the smallest verified change. It affects only a Codex process launched through the Taskboard launcher, requires one complete restart to adopt, and preserves the existing local server and iframe refresh architecture.

### Managed Chromium Policy

Use a macOS managed policy such as `LoopbackNetworkAllowedForUrls` to allow the Codex origin.

This can be more granular, but it requires machine-level managed preferences, administrator involvement, and policy maintenance. It is unsuitable for the repository's one-click local development launcher.

### Remote HTTPS URL or Tunnel

Serve the Taskboard through a public HTTPS origin.

This avoids loopback LNA checks, but introduces network availability, tunnel lifecycle, and endpoint configuration into a local-first development workflow. The user confirmed that remote URLs already work, so this remains an operational fallback rather than the chosen design.

## Chosen Design

### Launch Behavior

`scripts/codex-injector.mjs` will append `--disable-features=LocalNetworkAccessChecks` only when `launchCodex()` starts Codex. Existing CDP and remote-origin arguments remain unchanged.

The launcher will not terminate or relaunch an existing Codex process. As today, when Codex is already running without the required launch configuration, the user must quit it once and start it through `Start Codex Taskboard.command`.

### Development Refresh Behavior

No change is required to `npm run build`, `--refresh-frame-if-running`, `reloadFrame()`, the local HTTP server, or the React ready message. Once Codex is running with the launch flag, those existing paths can load the loopback document and complete the ready handshake.

### Agent Guidance

`AGENTS.md` will state that the one-click launcher starts Codex with the process-local LNA compatibility flag. It will distinguish the one-time adoption restart from ordinary development iteration: later web builds refresh the iframe, and injector/runtime edits use `npm run codex:reload`, without restarting Codex.

## Security Boundary

- The change does not alter Chrome, system, or enterprise policy globally.
- It does not patch Codex application files or React internals.
- The compatibility flag applies to the Codex process started by this repository's launcher.
- The existing Taskboard server remains bound to `127.0.0.1` by the normal launcher.
- The existing iframe origin/source checks and native host-action allowlists remain unchanged.

The trade-off is that the launched Codex process no longer enforces Chromium's LNA checks for other renderer requests during that process lifetime. This is broader than an origin policy, but it is the only directly verified route that works in the current Electron host without machine-level configuration.

## Files

- `scripts/codex-injector.mjs`: add the process-local Chromium feature-disable argument to `launchCodex()`.
- `AGENTS.md`: document the one-time adoption restart, flag scope, and no-restart development cycle.

No web application, iframe injection, server, persistence, cloud, generated bundle, or system preference changes are required.

## Error Handling

Existing launcher behavior remains authoritative:

- If Codex is already running without the launch configuration, the launcher reports that Codex must be fully quit and started again.
- If the local service or CDP endpoint is unavailable, existing startup errors remain visible.
- The iframe ready timeout remains a valid fallback for real loading failures; this design removes the known LNA cause rather than hiding the timeout.

## Direct-Path Verification

1. Complete one Codex restart through `Start Codex Taskboard.command` so the new process argument is active.
2. Confirm the Codex browser command line includes `--disable-features=LocalNetworkAccessChecks`.
3. Open the embedded Taskboard and confirm its iframe document is the real `127.0.0.1` page with a React root, not `chrome-error://chromewebdata/`.
4. Run `npm run build`.
5. Confirm the iframe receives a new refresh token, sends `taskboard:ready`, becomes visible, and does not show the timeout state.
6. Confirm the Codex application PID remains unchanged across the build refresh.

No new automated regression test is included before the user confirms the live direct path, per project rules.
