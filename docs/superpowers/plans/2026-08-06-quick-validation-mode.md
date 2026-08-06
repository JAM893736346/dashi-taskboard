# Quick Validation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default-on Quick Mode setting, visually separate from automatic processing, that runs automatic issues with GPT-5.6 Terra and low reasoning while preserving standard-mode choices.

**Architecture:** Extend the existing device-local automatic-processing settings with `quickMode`, then resolve one effective model/effort pair before quota lookup and claim creation. Expose a narrow PATCH mutation to `BoardSettingsMenu`; keep the existing automatic-processing panel responsible for standard-mode choices and disable those selectors while the override is active.

**Tech Stack:** React 19, TypeScript, Node.js ESM HTTP service, shared JavaScript domain modules, CSS, Vite.

---

## File Map

- `shared/automatic-processing.mjs`: setting default/normalization and effective execution-setting resolver.
- `shared/automatic-processing.d.mts`: shared type declarations for the new field and resolver.
- `web/src/types.ts`: browser contract for `quickMode`.
- `server/automatic-processing.mjs`: use the effective pair for quota and claim acquisition.
- `server/app.mjs`: accept a narrow local PATCH for the quick-mode field.
- `web/src/api.ts`: expose the typed quick-mode mutation.
- `web/src/components/BoardSettingsMenu.tsx`: load, display, and save the separate switch.
- `web/src/components/AutomaticProcessingMenu.tsx`: disable standard model controls while quick mode applies.
- `web/src/App.tsx`: provide local-capability availability to Board Settings.
- `web/src/styles.css`: style disabled selects consistently.

### Task 1: Extend The Shared Settings Contract

**Files:**
- Modify: `shared/automatic-processing.mjs:8-132`
- Modify: `shared/automatic-processing.d.mts:18-60`
- Modify: `web/src/types.ts:78-96`

- [x] **Step 1: Add the defaulted persisted field**

Add `"quickMode"` to `SETTING_KEYS`, set `quickMode: true` in `DEFAULT_AUTOMATIC_PROCESSING_SETTINGS`, and normalize missing version-1 values as enabled:

```js
const quickMode = value.quickMode ?? true;
if (typeof quickMode !== "boolean") fail("'quickMode' must be a boolean");

return {
  version: 1,
  enabled: value.enabled,
  quickMode,
};
```

Insert `quickMode` into the actual full return object without removing or reordering the remaining normalized fields.

- [x] **Step 2: Add one effective execution-setting resolver**

Export the preset and resolver from `shared/automatic-processing.mjs`:

```js
export const QUICK_VALIDATION_EXECUTION_SETTINGS = Object.freeze({
  executionModel: "gpt-5.6-terra",
  reasoningEffort: "low",
});

export function resolveAutomaticProcessingExecutionSettings(settings) {
  return settings.quickMode
    ? QUICK_VALIDATION_EXECUTION_SETTINGS
    : {
        executionModel: settings.executionModel,
        reasoningEffort: settings.reasoningEffort,
      };
}
```

- [x] **Step 3: Keep TypeScript declarations aligned**

Add `quickMode: boolean` to both `AutomaticProcessingSettings` interfaces. Declare the constant and resolver in `shared/automatic-processing.d.mts` with `executionModel` and `reasoningEffort` string fields.

- [x] **Step 4: Verify defaults and reversible resolution**

Run:

```bash
node --input-type=module -e 'import {DEFAULT_AUTOMATIC_PROCESSING_SETTINGS as d,normalizeAutomaticProcessingSettings as n,resolveAutomaticProcessingExecutionSettings as r} from "./shared/automatic-processing.mjs"; const old={...d}; delete old.quickMode; console.log(n(old).quickMode, r(d), r({...d,quickMode:false}))'
```

Expected output contains:

```text
true { executionModel: 'gpt-5.6-terra', reasoningEffort: 'low' } { executionModel: 'gpt-5.6-sol', reasoningEffort: 'high' }
```

### Task 2: Apply Effective Settings Before Claims

**Files:**
- Modify: `server/automatic-processing.mjs:3-4,178-255`

- [x] **Step 1: Resolve the model before quota lookup**

Import `resolveAutomaticProcessingExecutionSettings`. Change `#readQuota` to accept `executionModel`, and pass that model to `quotaReader`:

```js
async #readQuota(executionModel) {
  if (!this.settings.quotaAware) {
    this.quota = null;
    return true;
  }
  if (Date.now() - this.quotaCheckedAt >= 60_000 || !this.quota) {
    this.quota = await this.quotaReader(executionModel, {
      codexExecutable: this.codexExecutable,
    });
    this.quotaCheckedAt = Date.now();
  }
  return this.quota?.state === "available";
}
```

- [x] **Step 2: Use the same pair for local and cloud claim acquisition**

At the beginning of enabled reconciliation, derive:

```js
const executionSettings = resolveAutomaticProcessingExecutionSettings(this.settings);
```

Use `executionSettings.executionModel` for quota and claim `model`, use `executionSettings.reasoningEffort` for the claim effort, and pass this derived policy to `businessStore.acquire`:

```js
settings: { ...this.settings, ...executionSettings },
model: executionSettings.executionModel,
reasoningEffort: executionSettings.reasoningEffort,
```

Do not change `#launch`: its existing claim-derived `runSettings` guarantees retries use the model recorded when the claim was acquired.

### Task 3: Add The Narrow Settings Mutation

**Files:**
- Modify: `server/app.mjs:1540-1561`
- Modify: `web/src/api.ts:265-284`

- [x] **Step 1: Accept only `quickMode` in the PATCH request**

Add a PATCH branch beside GET and PUT:

```js
if (request.method === "PATCH") {
  const body = await readJson(request);
  assertPlainObject(body);
  assertAllowedKeys(body, new Set(["quickMode"]));
  if (typeof body.quickMode !== "boolean") {
    throw new ApiError(400, "INVALID_FIELD", "'quickMode' must be a boolean");
  }
  const settings = normalizeAutomaticProcessingSettings({
    ...dispatcher.getSettings(),
    quickMode: body.quickMode,
  });
  return sendJson(response, 200, {
    settings: await dispatcher.updateSettings(settings),
  });
}
```

Update the method allowlist to `GET`, `PUT`, and `PATCH`.

- [x] **Step 2: Add the browser API helper**

Export:

```ts
export async function updateAutomaticProcessingQuickMode(
  quickMode: boolean,
): Promise<AutomaticProcessingSettings> {
  const data = await request<{ settings: AutomaticProcessingSettings }>(
    "/api/local/automatic-processing/settings",
    { method: "PATCH", body: JSON.stringify({ quickMode }) },
  );
  return data.settings;
}
```

### Task 4: Place Quick Mode In Board Settings

**Files:**
- Modify: `web/src/components/BoardSettingsMenu.tsx:1-133`
- Modify: `web/src/components/AutomaticProcessingMenu.tsx:377-403`
- Modify: `web/src/App.tsx:1631-1634`
- Modify: `web/src/styles.css:1742-1760`

- [x] **Step 1: Load and save quick mode inside Board Settings**

Import `getAutomaticProcessingSettings` and `updateAutomaticProcessingQuickMode`. Add an `available: boolean` prop plus `quickMode`, loading, saving, and error state. Whenever the menu opens, load current settings with an `AbortController` and set `quickMode` from the response.

Use an optimistic save that restores the prior value on error:

```ts
async function saveQuickMode(next: boolean) {
  const previous = quickMode ?? true;
  setQuickMode(next);
  setQuickModeSaving(true);
  setQuickModeError(null);
  try {
    const settings = await updateAutomaticProcessingQuickMode(next);
    setQuickMode(settings.quickMode);
  } catch (error) {
    setQuickMode(previous);
    setQuickModeError(error instanceof Error ? error.message : "无法保存快速模式");
  } finally {
    setQuickModeSaving(false);
  }
}
```

- [x] **Step 2: Render a separate validation section**

After the existing `看板选项` section, render:

```tsx
<section className="board-settings-section" aria-labelledby="validation-options-heading">
  <h2 id="validation-options-heading">验证</h2>
  <div className="board-setting-row">
    <span className="board-setting-copy">
      <span>快速模式</span>
      <small>5.6 Terra · 低</small>
    </span>
    <button
      type="button"
      className={`board-setting-switch${(quickMode ?? true) ? " is-on" : ""}`}
      role="switch"
      aria-checked={quickMode ?? true}
      aria-label="快速模式"
      disabled={!available || quickModeLoading || quickModeSaving}
      onClick={() => void saveQuickMode(!(quickMode ?? true))}
    >
      <span aria-hidden="true" />
      <span className="sr-only">{(quickMode ?? true) ? "关闭快速模式" : "开启快速模式"}</span>
    </button>
  </div>
  {quickModeError && <p className="board-setting-error" role="alert">{quickModeError}</p>}
</section>
```

- [x] **Step 3: Pass local capability and prevent misleading standard edits**

Pass `available={taskboardMetadata?.localCapabilities?.available !== false}` from `App.tsx`. Add `disabled={draft.quickMode || saving}` to the model and reasoning selects in `AutomaticProcessingMenu`.

Extend the existing disabled control rule to include selects:

```css
.automatic-processing-field select:disabled,
.automatic-processing-field input:disabled {
  color: var(--text-tertiary);
  opacity: 0.62;
}
```

- [x] **Step 4: Compile the touched frontend contract**

Run `npm run typecheck`.

Expected: exit code 0 with no TypeScript errors.

### Task 5: Verify The Direct Product Path

**Files:**
- Verify only; no new test files.

- [x] **Step 1: Build production web assets**

Run `npm run build`.

Expected: Vite completes successfully and the optional Codex frame refresh either succeeds or reports that no debuggable window is available.

- [x] **Step 2: Start the development app and inspect the UI**

Run `npm run dev`, use the in-app browser at `http://127.0.0.1:5173`, select a project, and open Board Settings.

Confirm the `验证` section and Quick Mode switch are separate from the automatic-processing control, fit at desktop and mobile widths, and default to on when the persisted field was absent.

- [x] **Step 3: Demonstrate persistence and reversibility**

Record the current quick-mode value. Toggle it off in Board Settings, reopen the menu, and confirm it remains off. Open automatic-processing settings and confirm the standard model/effort selectors are enabled. Toggle Quick Mode back on, reopen both menus, and confirm the switch remains on while standard selectors are disabled.

Restore the user's original quick-mode value if verification changed it.

- [x] **Step 4: Confirm effective settings without starting a paid Codex run**

Run the shared resolver command from Task 1 and inspect the automatic-processing settings endpoint after each UI toggle. This proves the persisted setting and the exact effective Terra/low versus manual pair without creating or mutating a real issue merely for verification.

- [x] **Step 5: Review and commit only feature files**

Run:

```bash
git diff --check
git status --short
git diff -- shared/automatic-processing.mjs shared/automatic-processing.d.mts web/src/types.ts server/automatic-processing.mjs server/app.mjs web/src/api.ts web/src/components/BoardSettingsMenu.tsx web/src/components/AutomaticProcessingMenu.tsx web/src/App.tsx web/src/styles.css
```

Stage only those feature files and this plan if not already committed. Commit with:

```text
feat: add quick validation mode
```
