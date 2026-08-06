# Quick Validation Mode Design

## Status

Approved in conversation on 2026-08-06. The user selected the reversible mode: quick validation defaults on and uses GPT-5.6 Terra with low reasoning; turning it off restores the manually selected automatic-processing model and reasoning effort. The quick-validation control must be visually separate from the automatic-processing panel.

## Goal

Add one device-local quick-validation switch for lower-cost functional checks. Keep its UI in board settings, separate from the automatic-processing panel, while applying its effective model selection only when automatic processing starts a Codex run.

## Confirmed Operation Path

1. The user opens board settings and toggles Quick Validation.
2. The web app reads or patches the device-local automatic-processing settings through the local HTTP API.
3. The local service persists the `quickMode` boolean in `.data/automatic-processing.json`.
4. When the dispatcher starts a claimed issue, the runner resolves the effective execution settings.
5. Quick mode uses `gpt-5.6-terra` with `low` reasoning. Standard mode uses the saved `executionModel` and `reasoningEffort`.
6. The automatic-processing status and history continue to show the resulting execution and token usage.

## Settings Contract

Add one boolean to the existing device-local settings object:

```json
{
  "quickMode": true
}
```

The default is `true`. Existing version-1 files without the field normalize it to `true`, because default-enabled behavior is part of the requested main path. The manually selected `executionModel` and `reasoningEffort` remain persisted regardless of quick-mode state.

The quick setting stays in the automatic-processing configuration because that is the execution path it controls. It does not become browser `localStorage`, project data, D1 state, or a second configuration file.

## User Interface

Add a separate `Quick validation` row under a new validation section in `BoardSettingsMenu`. It uses the existing accessible switch treatment and is independent of the automatic-processing trigger and panel.

The row displays the current preset as `5.6 Terra / Low`. The switch defaults on. The UI saves immediately when toggled and restores the persisted value when settings reopen.

The automatic-processing panel does not contain a second quick-mode switch. Its model and reasoning selectors remain the saved standard-mode choices. When quick mode is active, they are disabled so the panel does not imply that edits affect the next run; turning quick mode off makes them editable again without losing their values.

## API And Data Flow

Reuse the existing settings read endpoint. Add a narrow patch mutation that accepts only:

```json
{
  "quickMode": true
}
```

The server merges this field into the latest settings object and passes the result through the existing normalizer and dispatcher update path. This avoids the board-settings UI sending a stale copy of unrelated automatic-processing fields.

The effective runner selection is:

```text
quickMode on  -> gpt-5.6-terra + low
quickMode off -> executionModel + reasoningEffort
```

Claim records continue to store the effective model and reasoning effort actually used.

## Errors

If settings cannot be loaded, disable the quick-mode switch and use the existing visible application error path. If saving fails, restore the previous switch value and surface the API error. Do not change automatic-processing state on a failed write.

## Direct-Path Verification

Before user confirmation, verify only the requested path:

1. Open board settings and confirm Quick Validation is visually separate from automatic processing and defaults on for a new or pre-field configuration.
2. Start one eligible automatic issue and confirm the execution request and claim use `gpt-5.6-terra` with `low` reasoning.
3. Turn quick mode off, select a different standard model and effort, start one eligible issue, and confirm those manual values are used.
4. Turn quick mode on again and confirm the manual values remain stored while the next execution returns to Terra with low reasoning.
5. Run the focused typecheck/build checks required by the touched web and server path.

## Non-Goals

- No Codex Fast service tier.
- No quick-mode control inside the automatic-processing panel.
- No changes to AI chat thread model selection.
- No per-project quick-mode overrides.
- No token hard limit or execution timeout.
- No unrelated injector changes or compatibility expansion beyond defaulting the new requested field.
