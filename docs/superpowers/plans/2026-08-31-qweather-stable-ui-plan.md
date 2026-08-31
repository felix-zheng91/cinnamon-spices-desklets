# QWeather Stable UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `qweather@felix` with fixed geometry so routine weather-data refreshes never change desklet width, height, spacing, or alignment.

**Architecture:** Keep the existing QWeather service contract and settings, but replace natural-size-driven UI layout with fixed geometry derived only from layout, zoom, enabled sections, and configured forecast-day count. Dynamic values update pre-created actors only; long text is bounded with end ellipsis and tooltips.

**Tech Stack:** Cinnamon Desklets, GJS, St/Clutter, Pango, CSS.

**Spec:** `docs/superpowers/specs/2026-08-31-qweather-stable-ui-design.md`

## Global Constraints

- Horizontal root base width is exactly 760 px before zoom.
- Vertical root base width is exactly 420 px before zoom.
- Routine API refreshes must not rebuild the window or measure natural width.
- Forecast rows equal the configured forecast-day count, never the current response length.
- Warning display uses one fixed-height slot and the first service warning as the primary alert.
- Dynamic text is single-line, end-ellipsized, bounded, and uses tooltip fallback where truncation is possible.
- Existing settings keys and user-facing feature toggles remain compatible.
- No new runtime dependencies.

---

### Task 1: Replace data-driven geometry with fixed layout primitives

**Files:**
- Modify: `qweather@felix/files/qweather@felix/desklet.js`

**Interfaces:**
- Consumes: existing settings and `QWeather.QWeather` data model.
- Produces: fixed root width, bounded-label helper, fixed metric/hourly/forecast/warning actors.

- [ ] Remove `_pinnedWidth`, `_widthCheckPending`, `_applyPinnedWidth()`, `_scheduleWidthCheck()`, and all callers.
- [ ] Make `_setDerivedValues()` derive forecast slot count from `userno` only, not returned-data length.
- [ ] Add bounded-label helpers that use `Pango.EllipsizeMode.END`, one line, and deterministic widths.
- [ ] Rebuild `_createWindow()` into header, current card, fixed warning strip, six hourly slots, row-oriented daily forecast, and footer.
- [ ] Apply fixed root width as `Math.round((layout === horizontal ? 760 : 420) * zoom)`.
- [ ] Keep rebuilds limited to explicit settings changes.

### Task 2: Make display functions geometry-neutral

**Files:**
- Modify: `qweather@felix/files/qweather@felix/desklet.js`

**Interfaces:**
- Consumes: fixed actors created by Task 1.
- Produces: content-only updates for current, hourly, forecast, warning, meta, footer/status.

- [ ] `displayCurrent()` updates only text/icon/colour/tooltips and uses `—` placeholders.
- [ ] `displayHourly()` always populates six existing slots; missing data clears icon and shows placeholders.
- [ ] `displayForecast()` never redraws; it fills exactly `userno` existing rows and uses placeholders for missing days.
- [ ] `displayWarning()` never creates variable-height banners; it updates the one warning slot and count.
- [ ] `displayMeta()` never inserts long API errors into the city field.
- [ ] Add a short bounded status indicator/tooltip for API errors instead of geometry-changing long messages.

### Task 3: Centralize stable visual styling

**Files:**
- Modify: `qweather@felix/files/qweather@felix/stylesheet.css`
- Modify: `qweather@felix/files/qweather@felix/desklet.js`

**Interfaces:**
- Consumes: style classes assigned by the layout.
- Produces: consistent spacing, section hierarchy, hover states, fixed-height slots, and restrained visual accents.

- [ ] Add classes for root/header/current/metrics/warning/hourly/daily/footer/status.
- [ ] Move non-user-configurable spacing/visual hierarchy from inline styles into CSS.
- [ ] Keep runtime inline styles only for zoom dimensions, user colours/background/border settings, AQI colour, and warning accent colour.
- [ ] Preserve existing theme override settings.

### Task 4: Static regression verification

**Files:**
- Verify: `qweather@felix/files/qweather@felix/desklet.js`
- Verify: `qweather@felix/files/qweather@felix/stylesheet.css`

**Interfaces:**
- Produces: repository-level evidence that data refresh paths cannot resize the desklet.

- [ ] Confirm there are no references to `_scheduleWidthCheck`, `_applyPinnedWidth`, `_pinnedWidth`, `_widthCheckPending`, or data-driven `actualDays` redraw logic.
- [ ] Confirm `displayCurrent`, `displayHourly`, `displayForecast`, `displayWarning`, and `displayMeta` do not call `redraw()` or `_createWindow()`.
- [ ] Confirm forecast loops target configured slots and warning uses one persistent actor.
- [ ] Re-read committed files from `master` and inspect the final diff.
- [ ] Report that Cinnamon real-machine visual verification is still required before claiming runtime-perfect UI behaviour.
