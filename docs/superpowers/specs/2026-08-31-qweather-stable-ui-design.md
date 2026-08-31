# QWeather Stable UI Design

## Goal

Redesign `qweather@felix` so weather data refreshes never change the desklet's geometry, spacing, or alignment. Data updates may change text, icons, colours, and tooltip contents only. Width and section geometry are controlled solely by explicit user settings such as layout, zoom, enabled sections, and forecast-day count.

## Scope

This redesign covers the Cinnamon desklet UI in:

- `qweather@felix/files/qweather@felix/desklet.js`
- `qweather@felix/files/qweather@felix/stylesheet.css`

The QWeather service/API layer remains unchanged except where a UI-facing contract is required. Existing settings and display toggles must remain compatible.

## Current Problems

The existing UI is natural-size driven. Labels use `Pango.EllipsizeMode.NONE`, and `_scheduleWidthCheck()` measures the newly rendered content and grows the desklet when text becomes wider. This makes city names, weather descriptions, AQI categories, wind descriptions, errors, warning titles, and attribution text capable of changing the window width.

The daily forecast also derives the rendered day count from returned data and may rebuild the entire window after a refresh. Warning banners are created and removed according to the number of active warnings. These behaviours allow both width and height to change as network responses change.

The stylesheet currently contains only minimal link styling, while most layout dimensions are assembled as inline styles in `desklet.js`. This makes consistent row heights, spacing, visual hierarchy, and fixed slot dimensions difficult to enforce.

## Design Principles

1. Data must never determine desklet geometry.
2. Every dynamic text field has a bounded display area.
3. All long text is single-line ellipsized with full text available in a tooltip.
4. Loading, missing, and error states use stable placeholders rather than removing actors or changing row structure.
5. Forecast and hourly content use fixed slots created once per layout build.
6. Warning presence or count must not alter desklet geometry.
7. Styles and spacing use a small set of shared visual tokens.
8. Existing user display settings remain functional.
9. No new runtime dependencies are introduced.
10. The implementation must remain compatible with the Cinnamon/GJS APIs already used by this desklet.

## Fixed Geometry Tokens

All pixel values below are base values multiplied by the existing `zoom` setting and rounded to integers at runtime.

- Horizontal root width: `760 px`.
- Vertical root width: `420 px`.
- Outer content padding: `14 px`.
- Section gap: `10 px`.
- Inner card padding: `10 px`.
- Header height: `30 px`.
- Warning strip height: `34 px`.
- Metric cell minimum height: `42 px`.
- Hourly slot icon height: `28 px`.
- Hourly slot content height: `70 px`.
- Daily forecast row height: `42 px`.
- Footer height: `30 px`.
- Standard corner radius for internal cards: `8 px`.

The existing user-configurable outer border radius remains authoritative for the desklet root.

## Geometry

### Horizontal layout

The root desklet has a fixed width of `round(760 * zoom)`.

The content hierarchy is:

1. Header: city name + last-updated timestamp.
2. Current weather card: icon, large temperature, weather description, current-condition metric grid.
3. Single-line warning/status strip.
4. Hourly section with six equal-width slots when enabled.
5. Daily forecast section with one fixed-height row per configured day.
6. Footer with QWeather attribution and refresh control.

### Vertical layout

The root desklet has a fixed width of `round(420 * zoom)`. It uses the same sections and slot rules as horizontal mode, but the current-weather summary is stacked above the metric grid.

### Height

Height may change only when the user explicitly changes enabled sections, current-condition metric toggles, or configured forecast-day count. Weather data changes, failures, warning counts, and response lengths must not change height.

## Text Rules

A bounded-label helper replaces the current unbounded `_createLabel()` behaviour for dynamic fields.

Dynamic labels must:

- use one line;
- use `Pango.EllipsizeMode.END`;
- use a fixed or allocated width determined by the parent slot;
- never expand their parent slot because of content;
- expose the full value via tooltip when truncation is possible.

Static captions may remain unellipsized when their width is fixed by the design.

The default missing/loading placeholder is `—`.

Errors must never replace city names, forecast day labels, or other primary data cells with long API messages. The UI displays the short bounded status `Update failed`; detailed service errors remain in tooltips.

## Header

The header contains:

- city name on the left/start side;
- last successful update time on the right/end side.

Both occupy fixed allocated regions. Long city names are ellipsized. The full location is exposed through tooltip text.

The update timestamp uses a compact label in the fixed header region and keeps the full localized timestamp in its tooltip.

## Current Weather Card

The current-weather area replaces the natural-width caption/value table with fixed cells.

Primary information:

- current icon;
- temperature;
- weather description.

Current conditions are presented as a two-column metric grid. Each metric contains a small caption and a value in a fixed-size cell. Enabled metrics are placed in deterministic order:

1. Feels like
2. Humidity
3. Wind
4. Pressure
5. Air quality
6. Visibility
7. Precipitation
8. UV index
9. Sunrise
10. Sunset

Changing a metric value must not alter any row/column spacing. AQI colour may change without changing font weight, dimensions, or padding.

## Warning Strip

The warning area is one fixed-height row whenever warning display is enabled.

When warnings exist:

- display the first active warning in the service-returned order;
- display a compact count indicator when more than one warning exists;
- ellipsize the title;
- use the displayed warning's colour only as a controlled accent/background;
- expose all active warning details in the tooltip.

When no warnings exist, keep the same row geometry and display `No active alerts` using the muted warning style.

Warning count must never create additional actors that increase height.

## Hourly Forecast

Hourly forecast always consists of exactly six equal-width slots when enabled.

Each slot contains fixed regions for:

- time;
- icon;
- temperature.

Missing hourly data fills the existing slot with `—` placeholders and no icon. It never removes a slot.

Tooltips retain weather description, feels-like temperature, precipitation probability, and wind details.

## Daily Forecast

The current days-as-columns matrix is replaced with row-oriented forecast entries.

The number of rows equals the user's configured forecast-day count, not the number returned by the current response.

Each row has fixed regions for:

- day label;
- icon;
- high/low temperatures according to enabled settings;
- wind speed/direction according to enabled settings;
- precipitation according to enabled settings;
- UV according to enabled settings.

If fewer days are returned than configured, remaining rows display placeholders. Returned-data length must never trigger a window rebuild.

Forecast errors use the fixed status treatment and placeholders; no long error string is inserted into a day label.

## Footer

The footer has one fixed-height row containing:

- compact attribution: `Data: QWeather` when there are no additional attribution entries, otherwise `Data: QWeather · N sources`;
- refresh button.

Full attribution metadata is exposed in the existing tooltip. Attribution length must not change desklet width.

## Styling Tokens

`stylesheet.css` becomes the primary source of stable visual classes. It defines classes for:

- root/card containers;
- header;
- city/title text;
- secondary/meta text;
- current-weather summary;
- metric cells and metric captions;
- section titles;
- separators;
- warning strip and muted no-warning state;
- hourly slots;
- daily rows;
- footer and link hover state.

Inline styles remain only where user-configurable values require runtime CSS, such as zoom-scaled dimensions, custom text/background/border colours, transparency, border radius, text shadow, and AQI/warning accent colours.

Spacing comes from the fixed geometry tokens rather than content-dependent natural sizes.

## Removal of Data-Driven Sizing

The following mechanisms are removed from the UI lifecycle:

- `_pinnedWidth`;
- `_widthCheckPending`;
- `_applyPinnedWidth()`;
- `_scheduleWidthCheck()`;
- natural-width measurement after data refresh;
- forecast-day-count changes driven by `days.length`;
- warning actor counts driven by `warnings.length`.

`displayCurrent()`, `displayHourly()`, `displayForecast()`, `displayWarning()`, and `displayMeta()` may update existing actors only. They must not resize the root window or trigger geometry rebuilds because of response data.

## Rebuild Rules

A UI rebuild is allowed only for explicit configuration changes that alter structure:

- horizontal/vertical layout;
- zoom where geometry is recomputed;
- enabled/disabled UI sections or metrics;
- configured forecast-day count;
- icon style when required by icon geometry.

Routine weather refreshes never rebuild the UI.

## Compatibility

The redesign preserves:

- all existing API/service behaviour;
- all existing settings keys;
- horizontal and vertical layouts;
- all current-condition display toggles;
- hourly toggle;
- warning toggle;
- forecast field toggles;
- region/country/manual-location display settings;
- theme override, transparency, colours, borders, corner radius, text shadow, zoom and icon style;
- QWeather attribution and clickable links.

No settings migration is required.

## Validation Criteria

The implementation is correct only if all of the following hold during repeated refreshes:

1. City name changes do not change root width.
2. Weather text changes from short to long do not change width or section spacing.
3. Temperature changes including negative values do not change geometry.
4. Wind, AQI, pressure, visibility, precipitation and UV value-length changes do not change metric-cell geometry.
5. API errors do not change root width or height.
6. Recovery from API errors does not change root width or height.
7. Forecast responses returning fewer days than configured do not rebuild or shrink the desklet.
8. Forecast responses later returning more days do not grow the desklet.
9. Warning count changing among 0, 1 and multiple warnings does not change height.
10. Attribution metadata length changes do not change width.
11. Hourly missing/returning data does not change slot dimensions.
12. Repeated manual refreshes do not produce visual jumping, spacing changes, or unclipped overflowing text; overlong text must use ellipsis with tooltip fallback.
13. Horizontal and vertical layouts remain visually balanced at multiple zoom values.
14. Existing settings continue to work without migration.

## Testing Strategy

Static review verifies that refresh display methods no longer call geometry measurement or rebuild paths.

Repository-level checks verify syntax/structure and ensure old width-pinning code is removed.

Real Cinnamon validation covers at least:

- valid Beijing/current data;
- Tokyo/local AQI data;
- a deliberately long manual location;
- invalid API key;
- blank/invalid API host;
- rapid repeated manual refresh;
- 3-day and 7/10-day forecast settings with fewer returned days;
- warnings absent and warnings present;
- multiple zoom values;
- horizontal and vertical layouts.

Because this repository does not provide a full Cinnamon compositor/runtime test harness, real-machine Cinnamon verification remains required before declaring the visual redesign fully validated.
