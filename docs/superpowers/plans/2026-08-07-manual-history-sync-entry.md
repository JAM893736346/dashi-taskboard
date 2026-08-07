# Manual History Sync Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move manual Codex history synchronization into a compact project-home overflow menu named `手动同步历史` while preserving the existing dialog and sync behavior.

**Architecture:** Keep the change local to the project-home UI in `App.tsx`: one boolean controls an anchored menu, and an effect closes it on outside click or Escape. Replace the existing secondary sync button with an icon trigger and one menu item; `styles.css` supplies the compact trigger and popover presentation.

**Tech Stack:** React 19, TypeScript, CSS, existing `LinearIcon` component

---

Project instructions explicitly replace test-first development for this feature. Do not add regression or mutation tests before user confirmation; verify only the approved direct interaction path.

### Task 1: Add The Project-Home Overflow Interaction

**Files:**
- Modify: `web/src/App.tsx:394-415`
- Modify: `web/src/App.tsx:638-655`
- Modify: `web/src/App.tsx:1878-1901`

- [ ] **Step 1: Add menu state beside the existing project-home dialog state**

Add one boolean without changing any synchronization state:

```tsx
  const [codexHistorySyncOpen, setCodexHistorySyncOpen] = useState(false);
  const [projectHomeMenuOpen, setProjectHomeMenuOpen] = useState(false);
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
```

- [ ] **Step 2: Close the menu from outside clicks and Escape**

Add an effect beside the existing project switcher close effect. Scope outside-click detection to the new wrapper and leave the existing project menu behavior unchanged:

```tsx
  useEffect(() => {
    if (!projectHomeMenuOpen) return;

    function closeProjectHomeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-home-menu]")) setProjectHomeMenuOpen(false);
    }

    function closeProjectHomeMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectHomeMenuOpen(false);
    }

    document.addEventListener("pointerdown", closeProjectHomeMenu);
    window.addEventListener("keydown", closeProjectHomeMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectHomeMenu);
      window.removeEventListener("keydown", closeProjectHomeMenuWithEscape);
    };
  }, [projectHomeMenuOpen]);
```

- [ ] **Step 3: Replace the visible history button with the overflow menu**

Keep `AutomaticProcessingMenu` and `创建项目` unchanged. Replace only the current `project-history-sync` button with:

```tsx
                <div className="project-home-menu" data-project-home-menu>
                  <button
                    type="button"
                    className="project-home-menu-trigger"
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={projectHomeMenuOpen}
                    title="更多操作"
                    onClick={() => setProjectHomeMenuOpen((current) => !current)}
                  >
                    <LinearIcon name="more" />
                  </button>
                  {projectHomeMenuOpen && (
                    <div className="project-home-menu-popover" role="menu" aria-label="更多操作">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={projects.length === 0}
                        onClick={() => {
                          setProjectHomeMenuOpen(false);
                          setCodexHistorySyncOpen(true);
                        }}
                      >
                        <LinearIcon name="terminal" />
                        <span>手动同步历史</span>
                      </button>
                    </div>
                  )}
                </div>
```

This keeps the existing `CodexHistorySyncDialog` mounting and all scan/import handlers unchanged.

### Task 2: Style The Compact Secondary Menu

**Files:**
- Modify: `web/src/styles.css:491-531`
- Modify: `web/src/styles.css:9297-9313`

- [ ] **Step 1: Replace the obsolete history-button rules**

Remove `.project-history-sync` and `.project-history-sync svg`, then add:

```css
.project-home-menu {
  position: relative;
  flex: 0 0 auto;
}

.project-home-menu-trigger {
  display: inline-grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-tertiary);
}

.project-home-menu-trigger:hover,
.project-home-menu-trigger:focus-visible,
.project-home-menu-trigger[aria-expanded="true"] {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.project-home-menu-trigger:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.project-home-menu-trigger svg {
  width: 16px;
  height: 16px;
}

.project-home-menu-popover {
  position: absolute;
  z-index: 50;
  top: calc(100% + 6px);
  right: 0;
  width: 176px;
  padding: 5px;
  border: var(--border-hairline) solid var(--border-strong);
  border-radius: 8px;
  background: var(--surface-raised);
  box-shadow: var(--dialog-shadow);
  animation: context-menu-in 90ms ease-out both;
}

.project-home-menu-popover button {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  gap: 8px;
  padding: 5px 7px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--text-primary);
  font-size: 11px;
  text-align: left;
}

.project-home-menu-popover button:hover:not(:disabled),
.project-home-menu-popover button:focus-visible {
  background: var(--surface-hover);
  outline: 0;
}

.project-home-menu-popover button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.project-home-menu-popover svg {
  flex: 0 0 auto;
  width: 15px;
  height: 15px;
}
```

- [ ] **Step 2: Remove the obsolete mobile alignment override**

Delete this rule from the `max-width: 620px` block because the text button no longer exists:

```css
  .project-history-sync {
    align-self: flex-start;
  }
```

The existing wrapping action row and right-anchored 176px popover keep the menu inside narrow viewports without another breakpoint.

### Task 3: Verify And Commit The Direct Path

**Files:**
- Verify: `web/src/App.tsx`
- Verify: `web/src/styles.css`
- Verify: `docs/superpowers/specs/2026-08-07-manual-history-sync-entry-design.md`
- Verify: `docs/superpowers/plans/2026-08-07-manual-history-sync-entry.md`

- [ ] **Step 1: Run static and production checks**

Run:

```bash
npm run typecheck
npm run build
git diff --check -- web/src/App.tsx web/src/styles.css
```

Expected: every command exits 0. `npm run build` may report the existing bundle-size warning and may refresh an open embedded iframe.

- [ ] **Step 2: Verify the standalone direct path**

Start the local development surface with `npm run dev`, open its reported localhost URL, and verify at desktop and narrow viewport widths:

```text
project home -> 更多操作 -> 手动同步历史 -> existing Codex history dialog
```

Confirm `创建项目` is the only primary text command, the menu does not clip or overlap adjacent controls, outside click and Escape close it, and zero projects disables the item rather than changing the dialog or API.

- [ ] **Step 3: Commit only the approved implementation**

Inspect status and diffs, then stage only:

```bash
git add web/src/App.tsx web/src/styles.css
git commit -m "feat: demote manual history sync action"
```

Leave `scripts/codex-injector-runtime.mjs`, `scripts/codex-injector.mjs`, `test/injector.test.mjs`, `.superpowers/`, and `test/injector-startup.test.mjs` untouched and unstaged.
