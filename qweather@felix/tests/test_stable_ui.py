#!/usr/bin/env python3
"""Static regression checks for the HTML-inspired qweather@felix UI."""

from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
DESKLET = ROOT / "files" / "qweather@felix" / "desklet.js"
STYLES = ROOT / "files" / "qweather@felix" / "stylesheet.css"


class HtmlRedesignSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = DESKLET.read_text(encoding="utf-8")
        cls.styles = STYLES.read_text(encoding="utf-8")

    def method_body(self, name: str) -> str:
        marker = f"  {name}: function ("
        start = self.source.find(marker)
        self.assertNotEqual(start, -1, f"missing method {name}")
        next_method = self.source.find("\n  ", start + len(marker))
        while next_method != -1 and not re.match(r"\n  [A-Za-z0-9_]+: function ", self.source[next_method:next_method + 100]):
            next_method = self.source.find("\n  ", next_method + 3)
        return self.source[start: next_method if next_method != -1 else len(self.source)]

    def test_mockup_geometry_constants_exist(self):
        self.assertIn("const QWX_BASE_WIDTH = 340;", self.source)
        self.assertIn("const QWX_DESIGN_SCALE = 2;", self.source)
        self.assertIn("const QWX_HOURLY_COUNT = 6;", self.source)
        self.assertIn("const QWX_METRIC_COLUMNS = 3;", self.source)
        self.assertIn("const QWX_METRIC_ROWS = 2;", self.source)

    def test_html_design_pixels_scale_to_cinnamon_pixels(self):
        body = self.method_body("_scale")
        self.assertIn("n * QWX_DESIGN_SCALE * z", body)
        self.assertIn("font-size: 92px", self.styles)
        self.assertIn("font-size: 26px", self.styles)
        self.assertIn("font-size: 20px", self.styles)

    def test_layout_has_mockup_sections(self):
        for token in ("qweather-alert", "qweather-top", "qweather-current", "qweather-metrics", "qweather-hourly", "qweather-daily", "qweather-source"):
            self.assertIn(token, self.source)

    def test_icon_holder_prevents_container_stretching(self):
        body = self.method_body("_iconHolder")
        self.assertIn("x_fill: false", body)
        self.assertIn("y_fill: false", body)
        self.assertNotIn("set_size(boxWidth, boxHeight)", body)

    def test_six_hourly_slots_are_persistent(self):
        self.assertRegex(self.source, r"for \(let h = 0; h < QWX_HOURLY_COUNT; h\+\+\)")
        body = self.method_body("displayHourly")
        self.assertIn("UIV2.hourText", body)
        self.assertNotIn("_createWindow()", body)
        self.assertNotIn("redraw()", body)

    def test_metric_grid_is_capped_at_six(self):
        self.assertIn("QWX_METRIC_COLUMNS * QWX_METRIC_ROWS", self.source)
        self.assertIn("slice(0, QWX_METRIC_COLUMNS * QWX_METRIC_ROWS)", self.source)

    def test_daily_rows_include_date_and_compact_temperatures(self):
        self.assertIn("dateLabel", self.source)
        self.assertIn("dayDate", self.source)
        body = self.method_body("displayForecast")
        self.assertIn("this._forecastDayDate", body)
        self.assertNotIn("row.detail.text", body)

    def test_visible_structural_copy_uses_ui_helper(self):
        for key in ("Today", "Tomorrow", "Refresh", "No active alerts", "Update failed", "Weather alert", "Data source"):
            self.assertIn(f"this._ui('{key}')", self.source)

    def test_refresh_display_methods_are_geometry_neutral(self):
        for name in ("displayCurrent", "displayHourly", "displayForecast", "displayWarning", "displayMeta"):
            body = self.method_body(name)
            self.assertNotIn("redraw()", body, name)
            self.assertNotIn("_createWindow()", body, name)

    def test_dynamic_labels_ellipsize(self):
        self.assertIn("Pango.EllipsizeMode.END", self.source)
        self.assertNotIn("Pango.EllipsizeMode.NONE", self.source)

    def test_footer_does_not_render_raw_attribution_urls(self):
        body = self.method_body("displayMeta")
        self.assertNotIn("attribution.url", body)
        self.assertNotIn("a.url", body)
        self.assertIn("QWeather", body)


if __name__ == "__main__":
    unittest.main()
