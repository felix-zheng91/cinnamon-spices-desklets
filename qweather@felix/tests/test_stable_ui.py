#!/usr/bin/env python3
"""Static regression checks for qweather@felix stable geometry.

These tests intentionally avoid a Cinnamon runtime. They protect the source-level
invariants that prevent weather responses from resizing or rebuilding the desklet.
Run from the repository root with:

    python3 -m unittest qweather@felix/tests/test_stable_ui.py
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]
DESKLET = ROOT / "files" / "qweather@felix" / "desklet.js"


class StableUiSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = DESKLET.read_text(encoding="utf-8")

    def method_body(self, name: str) -> str:
        marker = f"  {name}: function ("
        start = self.source.find(marker)
        self.assertNotEqual(start, -1, f"missing method {name}")
        next_method = self.source.find("\n  ", start + len(marker))
        while next_method != -1 and not re.match(r"\n  [A-Za-z0-9_]+: function ", self.source[next_method:next_method + 80]):
            next_method = self.source.find("\n  ", next_method + 3)
        return self.source[start: next_method if next_method != -1 else len(self.source)]

    def test_fixed_root_geometry_constants_exist(self):
        self.assertIn("const QWX_HORIZONTAL_WIDTH = 760;", self.source)
        self.assertIn("const QWX_VERTICAL_WIDTH = 420;", self.source)

    def test_old_data_driven_width_mechanisms_are_removed(self):
        for forbidden in (
            "_scheduleWidthCheck",
            "_applyPinnedWidth",
            "_pinnedWidth",
            "_widthCheckPending",
            "get_preferred_width",
        ):
            self.assertNotIn(forbidden, self.source)

    def test_forecast_geometry_is_not_driven_by_response_length(self):
        self.assertNotIn("actualDays", self.source)
        body = self.method_body("displayForecast")
        self.assertNotIn("redraw()", body)
        self.assertNotIn("_createWindow()", body)
        self.assertRegex(body, r"for \(let f = 0; f < this\.no; f\+\+\)")

    def test_refresh_display_methods_are_geometry_neutral(self):
        for name in ("displayCurrent", "displayHourly", "displayForecast", "displayWarning", "displayMeta"):
            body = self.method_body(name)
            self.assertNotIn("redraw()", body, name)
            self.assertNotIn("_createWindow()", body, name)
            self.assertNotIn("get_preferred_width", body, name)

    def test_warning_uses_persistent_single_slot(self):
        body = self.method_body("displayWarning")
        self.assertNotIn("destroy_all_children", body)
        self.assertNotRegex(body, r"for \(let i = 0; i < warnings\.length")
        self.assertIn("this._updateNotice()", body)

    def test_dynamic_labels_ellipsize(self):
        self.assertIn("Pango.EllipsizeMode.END", self.source)
        self.assertNotIn("Pango.EllipsizeMode.NONE", self.source)


if __name__ == "__main__":
    unittest.main()
