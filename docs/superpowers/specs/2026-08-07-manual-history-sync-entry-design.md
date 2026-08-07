# Manual History Sync Entry Design

## Status

Approved in conversation on 2026-08-07. The user selected a project-home overflow menu containing a renamed `手动同步历史` recovery action.

## Goal

Keep manual Codex history recovery available without presenting it as a peer of the primary `创建项目` action now that history synchronizes silently whenever Taskboard opens.

## Confirmed Operation Path

1. `web/src/App.tsx` renders the project-home actions when no project is selected.
2. The user opens the new overflow menu and chooses `手动同步历史`.
3. The menu item calls the existing `setCodexHistorySyncOpen(true)` state transition.
4. The existing `CodexHistorySyncDialog` opens without changing its scan, selection, project assignment, import, or refresh behavior.
5. Imported history remains observable through the existing project counts and issue lists.

## Interface Design

- Remove the visible `同步 Codex 历史` secondary button from the project-home action row.
- Add a compact icon-only overflow trigger using the existing `more` linear icon.
- Give the trigger the accessible name and tooltip `更多操作`.
- Render one menu item, `手动同步历史`, with the existing terminal icon.
- Disable the menu item when there are no projects, preserving the current eligibility rule.
- Close the menu after the item is selected and then open the existing history dialog.
- Keep `创建项目` as the only visually primary command. The automatic-processing control remains independent.

The overflow menu is a conventional project-home action container, but this change adds no speculative actions beyond manual history synchronization.

## State And Behavior

The project-home component owns a boolean open state for the overflow menu. The trigger toggles that state; selecting the history item closes it and opens the existing dialog. Clicking outside or pressing Escape closes the menu, following established popover behavior in the application.

No history-sync state, request, server route, persistence, matching rule, or automatic-sync trigger changes.

## Failure Behavior

The menu introduces no new network or data failure path. Errors after opening the dialog continue to use the dialog's existing feedback. Automatic synchronization remains silent, and the manual action remains the explicit recovery path for unmatched history or retry.

## Responsive Behavior

The trigger stays compact in the existing wrapping project-home action row. The menu is anchored to the trigger and remains within the viewport on narrow layouts. The removed text button no longer needs its dedicated mobile alignment rule.

## Non-Goals

- No change to automatic synchronization timing or scope.
- No change to the history dialog, API, import matching, or persistence.
- No new badge, status indicator, setting, retry policy, or notification.
- No additional overflow-menu actions.
- No unrelated project-home layout refactor.
- No new tests before user confirmation of the direct path.

## Direct-Path Verification

1. Open the project home with at least one project.
2. Confirm `创建项目` is the only primary text action and the overflow trigger is visible.
3. Open the overflow menu and confirm it contains `手动同步历史`.
4. Select the item and confirm the existing Codex history dialog opens.
5. Confirm the menu item is disabled when no project exists.
6. Check the narrow layout for clipping or overlap.
7. Run `npm run typecheck`, `npm run build`, and `git diff --check` for the changed source.
8. Commit only the implementation files, leaving unrelated worktree changes unstaged.
