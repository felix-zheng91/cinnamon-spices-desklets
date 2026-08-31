# QWeather HTML Redesign

## Goal

Rebuild the `qweather@felix` Cinnamon desklet UI from the supplied HTML mockup instead of iterating on the existing V2 layout. Keep the existing QWeather service/data layer and compatible settings, but replace the visual hierarchy, geometry, icon containers, and visible copy.

## Source of truth

The supplied `design-mockup.html` is the visual reference. The Cinnamon implementation should reproduce its proportions and hierarchy rather than preserve the current V2 card system.

## Layout

- Base desklet width: 340 CSS-like logical pixels before the existing `zoom` multiplier.
- Root padding: 10px top, 12px horizontal/bottom.
- Rounded outer frame with translucent background and subtle border.
- Sections, in order:
  1. warning card (only when an active warning exists; error state may reuse the slot),
  2. updated time + refresh pill,
  3. current conditions with large temperature/description/high-low on the left and weather icon/feels-like on the right,
  4. a fixed 3x2 metric grid,
  5. six hourly cards,
  6. daily forecast rows,
  7. a compact attribution footer.

## Metrics

The grid contains at most six items. Preserve existing display toggles where possible, filling the six stable positions from enabled metrics in this priority order: humidity, wind, UV, pressure, visibility, precipitation, air quality, sunrise, sunset, feels-like. Feels-like is normally shown beside the current icon and therefore only falls back into the grid when needed.

## Hourly forecast

- Always allocate six stable slots when hourly display is enabled.
- Each slot is a narrow rounded card with time, a centered proportional icon, and temperature.
- The first slot displays `现在`/localized `Now` when it corresponds to the current hour; subsequent Chinese times use `15时` style rather than `15:00`.
- Data refresh updates text and icons only; it must not rebuild the layout.

## Daily forecast

- Number of rows continues to honor the existing forecast-day setting, capped by the existing service limit.
- Each row has three visual columns: day/date block, proportional icon, high/low temperatures right-aligned.
- Chinese labels use `今天`, `明天`, then `周一`…`周日`.
- Date is displayed as `MM-DD` when available from service data.
- Wind/UV/precipitation detail strings are not shown inline in the compact daily row; they remain available in tooltip text.

## Icon behavior

Weather images must never be stretched by their container. The image actor is created at a proportional size and placed inside a fixed-size alignment box/button without fill. Current, hourly, and daily icons each have explicit maximum boxes.

## Localization

All visible structural UI text must go through one UI-localization helper rather than mixing runtime helper strings and legacy gettext calls. At minimum cover: Updated, Refresh, Now, Today, Tomorrow, weekdays, Hourly forecast, Future N days, No active alerts, Update failed, Weather alert, metric captions, Data source, No data.

API-provided weather descriptions, wind directions, AQI categories, and warning text remain in the language returned by QWeather.

## Attribution

The footer shows a concise source line (for example `数据来源: QWeather`). Raw attribution URLs are not rendered inline; full attribution details remain in the tooltip.

## Stability and compatibility

- Keep the existing QWeather API module and request lifecycle.
- Keep current settings bindings unless a setting only supported the removed V2 geometry.
- Weather responses update existing actors and must not call `redraw()` or rebuild the window.
- Dynamic text must ellipsize within bounded labels.
- No data-driven root width changes.

## Testing

Static regression tests should verify the 340px base geometry, 3x2 metric model, six hourly slots, compact daily rows, proportional icon container pattern, localized visible status strings, concise attribution, and geometry-neutral display methods. Run Python static tests and JavaScript syntax checks where available; final visual acceptance still requires loading the desklet in Cinnamon.