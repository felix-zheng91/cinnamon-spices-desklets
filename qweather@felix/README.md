# QWeather Weather Desklet (和风天气)

A Cinnamon desklet that displays weather from the [QWeather (和风天气)](https://www.qweather.com)
API. Built with Chinese users in mind, it offers excellent support for locations
in China, Chinese weather texts, air quality (AQI), and official severe weather
warnings issued by Chinese meteorological authorities.

![screenshot](screenshot.png)

## Features

* Current conditions with a large weather icon
* Hourly forecast strip for the next few hours
* Daily forecast for up to 10 days (depending on your subscription)
* Real-time local air quality index (AQI), coloured by pollution level, with
  QWeather QAQI used as a fallback when no local standard is returned
* Severe weather warning banners (台风、暴雨、高温……预警) with the full
  warning text in a tooltip
* City search through the QWeather GeoAPI — works with Chinese city names
  (`上海`), pinyin, English names, Location IDs and coordinates
* Weather texts in 30+ QWeather-supported languages, automatically following
  your system locale when possible
* Multiple icon styles, including the official QWeather icons
* Celsius/Fahrenheit, metric/imperial units, optional Beaufort wind force
  display (`3级` style)
* Fully translatable (simplified Chinese translation included)

## Requirements

* Cinnamon 5.4 or later (Linux Mint 21+ or equivalent)
* A [QWeather developer account](https://dev.qweather.com/) with an API key
* Your dedicated QWeather **API Host** from the QWeather console

## Configuration

After adding the desklet, open its settings and provide:

1. **API key** — create a project with *Web API* credentials at
   [dev.qweather.com](https://dev.qweather.com/), then copy the key into the
   desklet settings.
2. **API Host** — **required**. QWeather assigns every account a dedicated
   API Host (e.g. `abc123xyz.def.qweatherapi.com`). You find it in the
   [console](https://console.qweather.com/) under *设置*. The legacy public
   `api.qweather.com` host is being phased out from 2026, so the desklet no
   longer falls back to it.
3. **Location** — one of:
   * a city name, in Chinese or any supported language: `北京`, `Shanghai`,
     `哈尔滨`
   * a QWeather Location ID: `101010100`
   * coordinates as `longitude,latitude`: `116.41,39.92`. This is the
     documented order. The desklet only swaps the values automatically in the
     unambiguous reversed case where the second value cannot be a latitude.

   The desklet resolves names to coordinates with the QWeather GeoAPI and
   shows the city name returned by the service. You can override the
   displayed name in the settings.

### Display options

The settings dialog lets you toggle individual data rows (humidity, pressure,
visibility, precipitation, UV index, sunrise/sunset, AQI), the hourly forecast
strip, warning banners, and per-day forecast rows. See the tooltips in the
settings dialog for details.

## Reliability and API behaviour

The desklet keeps the previous successful data visible while refreshing and
ignores responses from superseded refreshes, so a slow older request cannot
overwrite newer data. It also recognises QWeather's legacy v1 JSON error codes
that may still be returned with HTTP 200 during the error-format transition.

The displayed **Last updated** time represents the last successful current
conditions response, not merely the most recent refresh attempt. Expired
weather warnings are removed locally even if the next warning refresh fails.

## Icons

* `icons/qweather/` — [QWeather Icons](https://icons.qweather.com/),
  © QWeather, licensed under
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Icon file names
  match the QWeather icon codes. They are rendered in white.
* `icons/light/`, `icons/dark/`, `icons/colourful/`, `icons/flat_black/`,
  `icons/flat_white/`, `icons/flat_colourful/` — icon sets from the
  [bbcwx](https://cinnamon-spices.linuxmint.com/desklets/view/20) desklet
  (© Merlin the Red, VClouds, digitalchet and others, see their README files),
  mapped from QWeather icon codes.
* `icons/user/` — drop your own icons here to use the *User defined* icon
  style, see `icons/user/README`.

## Acknowledgements

This desklet is based on **bbcwx** by Chris Hastie (which was itself forked
from *accudesk* by loganj). Much of the layout, styling and settings code
comes from bbcwx, licensed under GPLv3.

Weather data © [QWeather](https://www.qweather.com/). The desklet keeps the
"Data from QWeather" credit and also surfaces attribution metadata returned by
QWeather responses in the footer/tooltip when provided.

## License

GPLv3. See [COPYING](../COPYING) in the repository root.
