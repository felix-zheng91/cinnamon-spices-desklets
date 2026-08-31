# QWeather HTML Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current V2 desklet UI with a Cinnamon implementation of the supplied 340px HTML design while preserving the QWeather service layer and compatible settings.

**Architecture:** Keep `qweather.js` as the data/service boundary. Rebuild `desklet.js` as a fixed-geometry actor tree with persistent warning/current/metric/hourly/daily/footer actors, and use `uiv2.js` for visible UI localization plus small pure formatting helpers. Styling lives in `stylesheet.css`; refresh methods only mutate actor content.

**Tech Stack:** Cinnamon/GJS (`St`, `Clutter`, `Pango`, `Gio`, `GLib`), QWeather service module, Python `unittest` static regressions.

**Spec:** `docs/superpowers/specs/2026-08-31-qweather-html-redesign.md`

## Global Constraints

- Base logical width is exactly 340 before `zoom`.
- Hourly forecast uses exactly six persistent slots when enabled.
- Metric grid exposes at most six stable positions in three columns by two rows.
- Daily rows are compact day/date + icon + high/low rows; detail text moves to tooltip.
- Dynamic response display methods never rebuild layout.
- Weather icons preserve aspect ratio and are not stretched by button allocation.
- Visible structural copy uses the shared UI localization helper.
- Raw attribution URLs never render inline in the footer.

---

### Task 1: Replace stable-UI regression contract

**Files:**
- Modify: `qweather@felix/tests/test_stable_ui.py`

**Interfaces:**
- Consumes: `desklet.js` source text.
- Produces: source-level assertions for the new layout invariants.

- [ ] **Step 1: Write failing regression tests**

Assert the source contains `QWX_BASE_WIDTH = 340`, `QWX_HOURLY_COUNT = 6`, `QWX_METRIC_COLUMNS = 3`, `QWX_METRIC_ROWS = 2`, localized `Now`/`Tomorrow`/`Refresh` keys, an `_iconHolder` helper, and daily date labels. Assert `displayCurrent`, `displayHourly`, `displayForecast`, `displayWarning`, and `displayMeta` do not call `redraw()` or `_createWindow()`.

- [ ] **Step 2: Run the test and verify RED**

Run: `python3 -m unittest qweather@felix/tests/test_stable_ui.py -v`
Expected: FAIL because the current V2 source still declares the 760/420 geometry and old layout.

- [ ] **Step 3: Commit the failing contract**

Commit message: `qweather@felix: define HTML redesign regressions`

### Task 2: Expand pure UI localization/format helpers

**Files:**
- Modify: `qweather@felix/files/qweather@felix/uiv2.js`
- Test: `qweather@felix/tests/test_uiv2_helpers.js`

**Interfaces:**
- Produces: `uiText(lang, languageNames, key)`, `weekdayText(lang, languageNames, day)`, `hourText(lang, languageNames, value, isNow)`, `dayCountTitle(lang, languageNames, count)`, existing `iconDimensions()` and `cleanAttribution()`.

- [ ] **Step 1: Add helper tests**

Cover Simplified Chinese `现在`, `明天`, weekday labels, `刷新`, `无有效预警`, `更新失败`, `未来 7 天`, Chinese hour formatting (`15时`), English fallback, and existing icon/attribution behavior.

- [ ] **Step 2: Run helper test and verify RED**

Run: `node qweather@felix/tests/test_uiv2_helpers.js`
Expected: FAIL because the new helper functions/copy do not exist.

- [ ] **Step 3: Implement the minimal helpers**

Add the translation keys and pure formatting functions without GJS dependencies.

- [ ] **Step 4: Run helper tests and verify GREEN**

Run: `node qweather@felix/tests/test_uiv2_helpers.js`
Expected: all checks pass.

- [ ] **Step 5: Commit**

Commit message: `qweather@felix: add HTML redesign UI helpers`

### Task 3: Rebuild the Cinnamon actor tree

**Files:**
- Modify: `qweather@felix/files/qweather@felix/desklet.js`

**Interfaces:**
- Consumes: existing `QWeather.QWeather` data shape and settings keys; helper functions from `uiv2.js`.
- Produces: persistent actors for alert, current conditions, six metrics, six hourly slots, configured daily rows, and source footer.

- [ ] **Step 1: Implement fixed geometry and helper actors**

Replace the 760/420 constants with 340px base geometry. Add bounded-label, icon-holder, metric-cell, hourly-slot, and daily-row builders. Icon holders must center a proportional texture without fill.

- [ ] **Step 2: Implement the HTML section hierarchy**

Build: alert -> top row -> current -> 3x2 metrics -> hourly -> daily -> footer. Preserve existing settings callbacks and redraw only on structural/settings changes.

- [ ] **Step 3: Implement display mutation methods**

Populate current values, choose at most six enabled metrics, format six hourly slots, populate daily day/date/icon/high-low, update warnings/errors, and render only concise source text.

- [ ] **Step 4: Run static regression tests**

Run: `python3 -m unittest qweather@felix/tests/test_stable_ui.py -v`
Expected: PASS.

- [ ] **Step 5: Run JavaScript syntax check**

Run: `node --check qweather@felix/files/qweather@felix/desklet.js`
Expected: PASS (GJS globals are unresolved only at runtime; parsing must succeed).

- [ ] **Step 6: Commit**

Commit message: `qweather@felix: rebuild desklet from HTML design`

### Task 4: Replace V2 styles with mockup styles

**Files:**
- Modify: `qweather@felix/files/qweather@felix/stylesheet.css`

**Interfaces:**
- Consumes: CSS class names emitted by the rebuilt `desklet.js`.
- Produces: visual hierarchy matching the HTML mockup.

- [ ] **Step 1: Replace obsolete V2 card rules**

Implement translucent root/frame, warning accent, refresh pill, 3x2 metric cards, six hourly cards, compact daily rows, and subtle source divider. Do not rely on CSS to resize weather image children.

- [ ] **Step 2: Re-run source regressions and syntax checks**

Run both commands from Tasks 2 and 3; all must pass.

- [ ] **Step 3: Commit**

Commit message: `qweather@felix: style desklet to HTML mockup`

### Task 5: Final verification

**Files:**
- Review: all modified files.

**Interfaces:**
- Produces: verified master commit ready for manual Cinnamon visual acceptance.

- [ ] **Step 1: Run complete available checks**

Run:
`python3 -m unittest qweather@felix/tests/test_stable_ui.py -v`
`node qweather@felix/tests/test_uiv2_helpers.js`
`node --check qweather@felix/files/qweather@felix/desklet.js`
`node --check qweather@felix/files/qweather@felix/uiv2.js`

- [ ] **Step 2: Inspect final diff for forbidden regressions**

Confirm no inline attribution URLs, no 760/420 geometry constants, no response-path redraws, and no icon child fill/stretch pattern.

- [ ] **Step 3: Report runtime limitation**

State clearly that Cinnamon visual acceptance still requires the user to reload the desklet locally and send a screenshot if pixel-level tuning is needed.
