/*
 * qweather@felix - a Cinnamon desklet displaying weather from the
 * QWeather (和风天气) API.
 *
 * Features:
 *  - current conditions with large icon
 *  - hourly forecast strip
 *  - up to 10 day forecast
 *  - real-time air quality (AQI) with colours
 *  - severe weather warning banners
 *  - city search via the QWeather GeoAPI (Chinese and worldwide locations)
 *
 * Based on bbcwx@oak-wood.co.uk by Chris Hastie (GPLv3), itself forked
 * from accudesk@logan by loganj. Original code Copyright 2013 loganj,
 * 2014-2018 Chris Hastie, 2026 felix.
 *
 * Icons: QWeather Icons (c) QWeather, CC BY 4.0, see icons/qweather/;
 * additional icon sets from bbcwx, see icons/ subdirectories.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const ByteArray = imports.byteArray;
const Desklet = imports.ui.desklet;
const GLib = imports.gi.GLib;
const Gettext = imports.gettext;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Pango = imports.gi.Pango;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;

const UUID = 'qweather@felix';

// DESKLET_DIR is resolved per instance in _init (see below) to support the
// devtest- prefix used by the test-spice script and any future renames.
// The QWeather module is loaded lazily in _init once DESKLET_DIR has been
// pushed onto the search path; the constants are read from it there too.
let QWeather = null;
let SERVICE_STATUS_OK = 2;
let SERVICE_STATUS_ERROR = 0;

// constants for layout and styling
const QWX_TEXT_SIZE = 14;
const QWX_CC_TEXT_SIZE = 24;
const QWX_LABEL_TEXT_SIZE = 11;
const QWX_LINK_TEXT_SIZE = 10;
const QWX_REFRESH_ICON_SIZE = 14;
const QWX_TABLE_ROW_SPACING = 2;
const QWX_TABLE_COL_SPACING = 5;
const QWX_TABLE_PADDING = 5;
const QWX_CONTAINER_PADDING = 12;
const QWX_ICON_HEIGHT = 40;
const QWX_CC_ICON_HEIGHT = 170;
const QWX_HOURLY_ICON_HEIGHT = 28;
const QWX_HOURLY_COUNT = 6;
const QWX_BUTTON_PADDING = 3;
const QWX_LABEL_PADDING = 4;
const QWX_TEMP_PADDING = 12;
const QWX_SEPARATOR_STYLE = 'qweather-separator';
const QWX_DEFAULT_ICONSET = 'qweather';
const QWX_WEBSITE = 'https://www.qweather.com';
const QWX_CONSOLE = 'https://console.qweather.com';

const ALIGN_CENTER = { x_fill: false, y_fill: true, x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE, expand: true };
const ALIGN_LEFT = { x_fill: false, y_fill: true, x_align: St.Align.START, y_align: St.Align.MIDDLE, expand: true };
const ALIGN_RIGHT = { x_fill: false, y_fill: true, x_align: St.Align.END, y_align: St.Align.MIDDLE, expand: true };

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(str) {
  if (str) return Gettext.dgettext(UUID, str);
}

function MyDesklet(metadata, desklet_id) {
  this._init(metadata, desklet_id);
}

MyDesklet.prototype = {
  __proto__: Desklet.Desklet.prototype,

  _init: function (metadata, desklet_id) {
    this.desklet_id = desklet_id;
    this.metadata = metadata;

    // resolve DESKLET_DIR from metadata (handles devtest- prefix and any
    // future renames); fall back to the deskletManager registry
    this._deskletDir = metadata ? metadata.path : null;

    // call the parent constructor first; note that Desklet._init sets
    // this._uuid = null, so we must assign our UUID *after* this call.
    Desklet.Desklet.prototype._init.call(this, metadata);

    // the UUID used for settings must match the UUID under which the
    // extension was registered with Cinnamon (which the test-spice script
    // rewrites to devtest-<uuid>). metadata.uuid should normally match,
    // but on some code paths metadata may be a dummy without uuid, so we
    // fall back to scanning deskletMeta by path.
    this._uuid = (metadata && metadata.uuid) ? metadata.uuid : UUID;
    if (this._uuid === UUID && metadata && metadata.path) {
      // verify the hard-coded UUID is actually registered; otherwise scan
      // deskletMeta for a matching path
      let registered = false;
      try {
        registered = !!imports.ui.deskletManager.deskletMeta[this._uuid];
      } catch (e) { }
      if (!registered) {
        for (let u in imports.ui.deskletManager.deskletMeta) {
          if (imports.ui.deskletManager.deskletMeta[u].path === metadata.path) {
            this._uuid = u;
            break;
          }
        }
      }
    }

    if (this._deskletDir && imports.searchPath.indexOf(this._deskletDir) === -1) {
      imports.searchPath.push(this._deskletDir);
    }

    // load the QWeather API module now that the search path is set up
    QWeather = imports.qweather;
    SERVICE_STATUS_OK = QWeather.SERVICE_STATUS_OK;
    SERVICE_STATUS_ERROR = QWeather.SERVICE_STATUS_ERROR;

    // days of the week
    this.daynames = { Mon: _('Mon'), Tue: _('Tue'), Wed: _('Wed'), Thu: _('Thu'), Fri: _('Fri'), Sat: _('Sat'), Sun: _('Sun') };

    this.redrawNeeded = false;
    this._rebuildPending = false;
    this._pinnedWidth = -1;
    this._widthCheckPending = false;
    this.oldno = 0;
    this.oldshifttemp = '';
    this._timeoutId = null;

    try {
      this.settings = new Settings.DeskletSettings(this, this._uuid, this.desklet_id);

      // QWeather account and location. Changing these needs a refetch
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'apikey', 'apikey', this.changeService, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'apihost', 'apihost', this.changeService, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'location', 'location', this.changeService, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'lang', 'lang', this.changeService, null);

      // units
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'tunits', 'tunits', this.onUnitChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'wunits', 'wunits', this.onUnitChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'windscale', 'windscale', this.onUnitChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'punits', 'punits', this.onUnitChange, null);

      // number of forecast days: change the request and the window
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'userno', 'userno', this.redrawRefetch, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'refreshtime', 'refreshtime', this.changeRefresh, null);

      // optional display items: need a redraw
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__weather', 'display__cc__weather', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__feelslike', 'display__cc__feelslike', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__humidity', 'display__cc__humidity', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__wind_speed', 'display__cc__wind_speed', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__pressure', 'display__cc__pressure', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__visibility', 'display__cc__visibility', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__precip', 'display__cc__precip', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__aqi', 'display__cc__aqi', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__uv', 'display__cc__uv', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__cc__sun', 'display__cc__sun', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__hourly', 'display__hourly', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__warning', 'display__warning', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__forecast__maximum_temperature', 'display__forecast__maximum_temperature', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__forecast__minimum_temperature', 'display__forecast__minimum_temperature', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__forecast__wind_speed', 'display__forecast__wind_speed', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__forecast__wind_direction', 'display__forecast__wind_direction', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__forecast__uv', 'display__forecast__uv', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__forecast__precip', 'display__forecast__precip', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__meta__region', 'display__meta__region', this.metaOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'display__meta__country', 'display__meta__country', this.metaOptsChange, null);

      // styling
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'zoom', 'zoom', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'layout', 'layout', this.displayOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'iconstyle', 'iconstyle', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'citystyle', 'citystyle', this.metaOptsChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'overrideTheme', 'overrideTheme', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.BIDIRECTIONAL, 'transparency', 'transparency', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'textcolor', 'textcolor', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'textshadow', 'textshadow', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'shadowblur', 'shadowblur', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'bgcolor', 'bgcolor', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'cornerradius', 'cornerradius', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'border', 'border', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'bordercolor', 'bordercolor', this.updateStyle, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'borderwidth', 'borderwidth', this.updateStyle, null);

      // location display
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'manuallocation', 'manuallocation', this.displayMeta, null);

      // experimental
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'experimental_enabled', 'experimental_enabled', this.setGravity, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'gravity', 'gravity', this.setGravity, null);

      // refresh styling when global desklet decorations change
      this._globalSettingsSignalId = global.settings.connect('changed::desklet-decorations', Lang.bind(this, this.updateStyle));

      // a subprocess launcher for opening links
      this.launcher = new Gio.SubprocessLauncher({
        flags: (Gio.SubprocessFlags.STDIN_PIPE |
          Gio.SubprocessFlags.STDOUT_PIPE |
          Gio.SubprocessFlags.STDERR_PIPE)
      });

      this.setHeader(_('Weather'));
      this._menu.addAction(_('QWeather console'), Lang.bind(this, function () {
        this.launcher.spawnv(['xdg-open', QWX_CONSOLE]);
      }));

      this.initForecast();
    }
    catch (e) {
      global.logError(e);
    }
    return true;
  },

  // create the service object and start
  initForecast: function () {
    this.service = new QWeather.QWeather(this.apikey, this.apihost, this.location);
    this.service.setLang(this.lang);
    this.service.setMaxDays(this.userno);
    this.actualDays = null;

    this._setDerivedValues();
    this._createWindow();
    this.setGravity();
    this._update_style();
    this._refreshweathers();
  },

  // API key, host, location or language changed
  changeService: function () {
    if (this._removed) return;
    // the whole service object is recreated, as the geo cache depends on
    // the key and host
    this.initForecast();
  },

  // Set internal values derived from user choices
  _setDerivedValues: function () {
    this.vertical = this.layout;

    // make the service aware of the requested number of days before
    // calculating how many to display
    this.service.setMaxDays(this.userno);

    // number of forecast days to display, limited by the number of days
    // actually returned by the service
    this.no = Math.min(this.userno, this.service.maxDays);
    if (this.actualDays) this.no = Math.min(this.no, this.actualDays);

    // refresh period, no shorter than the service minimum
    this.refreshSec = Math.max(this.refreshtime * 60, this.service.minTTL);

    // with more than four days and a horizontal layout, move the current
    // temperature next to the current conditions
    this.shifttemp = (this.no > 4 && this.vertical == 0);

    this.currenttempadding = QWX_TEMP_PADDING;
    this.currenttempsize = QWX_CC_TEXT_SIZE;

    this.service.wantHourly = this.display__hourly;
    this.service.wantAir = this.display__cc__aqi;
    this.service.wantWarning = this.display__warning;

    this._initIcons();

    // number of current condition rows on display
    let ccShowCount = 0;
    if (this.display__cc__feelslike) ccShowCount++;
    if (this.display__cc__humidity) ccShowCount++;
    if (this.display__cc__wind_speed) ccShowCount++;
    if (this.display__cc__pressure) ccShowCount++;
    if (this.display__cc__visibility) ccShowCount++;
    if (this.display__cc__precip) ccShowCount++;
    if (this.display__cc__aqi) ccShowCount++;
    if (this.display__cc__uv) ccShowCount++;
    if (this.display__cc__sun) ccShowCount += 2; // sunrise + sunset
    if (ccShowCount < 1) this.shifttemp = false;

    // if the current weather icon and text are hidden, show a big
    // temperature instead and force the vertical layout
    this.showweather = this.display__cc__weather;
    if (!this.showweather) {
      this.shifttemp = true;
      this.currenttempsize = this.currenttempsize * 1.7;
      this.vertical = 1;
      if (ccShowCount < 1) this.currenttempadding = 0;
    }
  },

  // Set internal values for icons
  _initIcons: function () {
    this.iconprops = this._getIconMeta(this.iconstyle);
    this.defaulticonprops = this._getIconMeta(QWX_DEFAULT_ICONSET);
  },

  // Fetch the icon set meta data
  _getIconMeta: function (iconset) {
    let iconprops = new Object();
    let deficonprops = {
      aspect: 1,
      adjust: 1,
      ext: 'png',
      map: {}
    };

    let file = Gio.file_new_for_path(this._deskletDir + '/icons/' + iconset + '/iconmeta.json');
    try {
      let raw_json = GLib.file_get_contents(file.get_path())[1];
      iconprops = JSON.parse(ByteArray.toString(raw_json));
    } catch (e) {
      global.logError('Failed to parse iconmeta.json for iconset ' + iconset);
    }
    for (let prop in deficonprops) {
      if (typeof iconprops[prop] === 'undefined') {
        iconprops[prop] = deficonprops[prop];
      }
    }
    return iconprops;
  },

  // Create the layout of the desklet
  _createWindow: function () {
    if ((this.no == this.oldno) && (this.oldshifttemp == this.shifttemp) && !this.redrawNeeded) {
      return;
    }
    this.oldno = this.no;
    this.oldshifttemp = this.shifttemp;
    this.redrawNeeded = false;

    // disconnect signals from the old window before destroying its actors
    try {
      if (this.bannersig) this.banner.disconnect(this.bannersig);
      if (this.cwiconsig && this.cwicon) this.cwicon.disconnect(this.cwiconsig);
      this.bannersig = null;
      this.cwiconsig = null;
    } catch (e) { }

    // destroy the old window to avoid leaking actors across rebuilds
    if (this.window) {
      try { this.window.destroy_all_children(); } catch (e) { }
    }

    // Clear references to actors that are destroyed with the old window.
    // Leaving them behind would make the display* methods below update
    // disposed Clutter actors whenever a row/table is toggled off.
    this.feelslike = null;
    this.humidity = null;
    this.windspeed = null;
    this.pressure = null;
    this.airquality = null;
    this.airqualitytooltip = null;
    this.visibility = null;
    this.precip = null;
    this.uv = null;
    this.sunrise = null;
    this.sunset = null;
    this.currenttemp = null;
    this.ctemp_bigtemp = null;
    this.weathertext = null;
    this.hourlytable = null;
    this._hourlySepArea = null;
    this.hlabels = [];
    this.hicons = [];
    this.htemps = [];
    this.htooltips = [];
    this.bannerupdated = null;
    this.updatedtooltip = null;
    this.cwicontooltip = null;
    this.bannertooltip = null;
    this.refreshtooltip = null;

    this.window = new St.BoxLayout({ vertical: true });

    // area holding the severe weather warning banners
    this.warningArea = new St.BoxLayout({ vertical: true, x_align: St.Align.MIDDLE, style_class: 'qweather-warning-area' });

    // the main box, orientation depends on the layout setting
    this.mainbox = new St.BoxLayout({ vertical: (this.vertical == 1) ? true : false });

    // upper / left part: city, current weather icon and text
    this.cweather = new St.BoxLayout({ vertical: true, x_align: St.Align.END });

    this.cityname = this._createLabel();
    this.city = new St.BoxLayout({ vertical: true });
    this.city.add(this.cityname, ALIGN_CENTER);
    this.cweather.add_actor(this.city);

    // current weather icon
    this.cwicon = this.showweather ? new St.Button() : null;
    if (this.cwicon) this.cweather.add(this.cwicon, ALIGN_CENTER);

    // current weather text
    this.weathertext = this.showweather ? this._createLabel() : null;

    // current temperature on wide layouts
    if (this.shifttemp) {
      this.ctemp_bigtemp = new St.BoxLayout({ vertical: false, y_align: St.Align.END });
      this.currenttemp = this._createLabel();
      this.ctemp_bigtemp.add(this.currenttemp, ALIGN_CENTER);
    }

    // current weather text (below the big icon)
    if (this.weathertext) this.cweather.add(this.weathertext, ALIGN_CENTER);

    // lower / right part: current conditions table, hourly forecast,
    // forecast table and buttons
    this.container = new St.BoxLayout({ vertical: true, x_align: St.Align.END });

    // current conditions values and captions
    this.ctemp = new St.BoxLayout({ vertical: false, x_align: St.Align.END, y_align: St.Align.END });
    this.ctemp_values = new St.BoxLayout({ vertical: true, y_align: St.Align.END });
    this.ctemp_captions = new St.BoxLayout({ vertical: true, y_align: St.Align.END });

    if (this.shifttemp && this.ctemp_bigtemp) this.ctemp.add(this.ctemp_bigtemp, ALIGN_CENTER);

    // Use an St.Table for the current conditions so that captions and values
    // share the same row heights and never go out of alignment.
    this.ccTable = new St.Table();
    this.ccRowIndex = 0;
    this._addCCRow = function (captionText, valueVarName) {
      let caption = this._createLabel(captionText);
      this[valueVarName] = this._createLabel();
      this.ccTable.add(caption, { row: this.ccRowIndex, col: 0, x_align: St.Align.END, y_align: St.Align.MIDDLE, x_fill: false, y_fill: false });
      this.ccTable.add(this[valueVarName], { row: this.ccRowIndex, col: 1, x_align: St.Align.START, y_align: St.Align.MIDDLE, x_fill: false, y_fill: false });
      this.ccRowIndex++;
    };

    if (this.display__cc__feelslike) this._addCCRow(_('Feels like:'), 'feelslike');
    if (this.display__cc__humidity) this._addCCRow(_('Humidity:'), 'humidity');
    if (this.display__cc__wind_speed) this._addCCRow(_('Wind:'), 'windspeed');
    if (this.display__cc__pressure) this._addCCRow(_('Pressure:'), 'pressure');
    if (this.display__cc__aqi) this._addCCRow(_('Air quality:'), 'airquality');
    if (this.display__cc__visibility) this._addCCRow(_('Visibility:'), 'visibility');
    if (this.display__cc__precip) this._addCCRow(_('Precipitation:'), 'precip');
    if (this.display__cc__uv) this._addCCRow(_('UV index:'), 'uv');
    if (this.display__cc__sun) this._addCCRow(_('Sunrise:'), 'sunrise');
    if (this.display__cc__sun) this._addCCRow(_('Sunset:'), 'sunset');

    this.ctemp.add(this.ccTable, { x_align: St.Align.END, y_align: St.Align.END, x_fill: false, y_fill: false, expand: false });
    this.container.add_actor(this.ctemp);

    // tooltip with details for the air quality row
    if (this.airquality) this.airqualitytooltip = new Tooltips.Tooltip(this.airquality);

    this._separatorArea = new St.DrawingArea({ style_class: QWX_SEPARATOR_STYLE });
    this.container.add_actor(this._separatorArea);

    // hourly forecast strip
    if (this.display__hourly) {
      this._hourlySepArea = new St.DrawingArea({ style_class: QWX_SEPARATOR_STYLE });
      this.hourlytable = new St.Table();
      this.hlabels = [];
      this.hicons = [];
      this.htemps = [];
      this.htooltips = [];
      for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
        this.hlabels[h] = this._createLabel();
        this.hicons[h] = new St.Button();
        this.htemps[h] = this._createLabel();
        this.htooltips[h] = new Tooltips.Tooltip(this.hicons[h]);
        this.hourlytable.add(this.hlabels[h], { ...ALIGN_CENTER, row: 0, col: h });
        this.hourlytable.add(this.hicons[h], { ...ALIGN_CENTER, row: 1, col: h });
        this.hourlytable.add(this.htemps[h], { ...ALIGN_CENTER, row: 2, col: h });
      }
      this.container.add_actor(this._hourlySepArea);
      this.container.add_actor(this.hourlytable);
    }

    // daily forecast table
    this.fwtable = new St.Table();
    this.labels = [];
    this.fwicons = [];
    this.max = [];
    this.min = [];
    this.winds = [];
    this.windd = [];
    this.fuv = [];
    this.fprecip = [];
    this.wxtooltip = [];

    // captions in the first column
    this.maxlabel = this._createLabel(_('Max:'));
    this.minlabel = this._createLabel(_('Min:'));
    this.windlabel = this._createLabel(_('Wind speed:'));
    this.winddlabel = this._createLabel(_('Dir:'));
    this.fuvlabel = this._createLabel(_('UV:'));
    this.fpreciplabel = this._createLabel(_('Precip:'));

    let row = 2;
    if (this.display__forecast__maximum_temperature) { this.fwtable.add(this.maxlabel, { ...ALIGN_RIGHT, row: row, col: 0 }); row++; }
    if (this.display__forecast__minimum_temperature) { this.fwtable.add(this.minlabel, { ...ALIGN_RIGHT, row: row, col: 0 }); row++; }
    if (this.display__forecast__wind_speed) { this.fwtable.add(this.windlabel, { ...ALIGN_RIGHT, row: row, col: 0 }); row++; }
    if (this.display__forecast__wind_direction) { this.fwtable.add(this.winddlabel, { ...ALIGN_RIGHT, row: row, col: 0 }); row++; }
    if (this.display__forecast__uv) { this.fwtable.add(this.fuvlabel, { ...ALIGN_RIGHT, row: row, col: 0 }); row++; }
    if (this.display__forecast__precip) { this.fwtable.add(this.fpreciplabel, { ...ALIGN_RIGHT, row: row, col: 0 }); row++; }

    for (let f = 0; f < this.no; f++) {
      this.labels[f] = this._createLabel();
      this.fwicons[f] = new St.Button();
      if (this.display__forecast__maximum_temperature) this.max[f] = this._createLabel();
      if (this.display__forecast__minimum_temperature) this.min[f] = this._createLabel();
      if (this.display__forecast__wind_speed) this.winds[f] = this._createLabel();
      if (this.display__forecast__wind_direction) this.windd[f] = this._createLabel();
      if (this.display__forecast__uv) this.fuv[f] = this._createLabel();
      if (this.display__forecast__precip) this.fprecip[f] = this._createLabel();
      this.wxtooltip[f] = new Tooltips.Tooltip(this.fwicons[f]);

      this.fwtable.add(this.labels[f], { ...ALIGN_CENTER, row: 0, col: f + 1 });
      this.fwtable.add(this.fwicons[f], { ...ALIGN_CENTER, row: 1, col: f + 1 });
      row = 2;
      if (this.max[f]) { this.fwtable.add(this.max[f], { ...ALIGN_CENTER, row: row, col: f + 1 }); row++; }
      if (this.min[f]) { this.fwtable.add(this.min[f], { ...ALIGN_CENTER, row: row, col: f + 1 }); row++; }
      if (this.winds[f]) { this.fwtable.add(this.winds[f], { ...ALIGN_CENTER, row: row, col: f + 1 }); row++; }
      if (this.windd[f]) { this.fwtable.add(this.windd[f], { ...ALIGN_CENTER, row: row, col: f + 1 }); row++; }
      if (this.fuv[f]) { this.fwtable.add(this.fuv[f], { ...ALIGN_CENTER, row: row, col: f + 1 }); row++; }
      if (this.fprecip[f]) { this.fwtable.add(this.fprecip[f], { ...ALIGN_CENTER, row: row, col: f + 1 }); row++; }
    }
    this.container.add_actor(this.fwtable);

    // credit link, update time and refresh button
    this.buttoncontainer = new St.BoxLayout({ vertical: true, x_align: St.Align.END, y_align: St.Align.END });
    this.buttons = new St.BoxLayout({ vertical: false, x_align: St.Align.END, y_align: St.Align.END });

    this.iconbutton = new St.Icon({
      icon_name: 'view-refresh-symbolic',
      icon_type: St.IconType.SYMBOLIC
    });
    this.refreshbutton = new St.Button();
    this.refreshbutton.set_child(this.iconbutton);
    this.refreshbutton.connect('clicked', Lang.bind(this, this._refreshweathers));

    this._setLastUpdated();

    // Credit the data supplier. A link to the supplier follows this text
    this.bannerpre = new St.Button({ label: _('Data from ') });
    this.bannerpost = new St.Button({ label: ' ' });
    this.banner = new St.Button({
      reactive: true,
      track_hover: true,
      style_class: 'qweather-link'
    });
    this.banner.label = 'QWeather';
    this.bannertooltip = new Tooltips.Tooltip(this.banner);
    this.refreshtooltip = new Tooltips.Tooltip(this.refreshbutton, _('Refresh'));
    if (this.cwicon) this.cwicontooltip = new Tooltips.Tooltip(this.cwicon);

    this.buttons.add_actor(this.bannerpre);
    this.buttons.add_actor(this.banner);
    this.buttons.add_actor(this.bannerpost);
    this.buttons.add_actor(this.refreshbutton);
    this.buttoncontainer.add_actor(this.bannerupdated);
    this.buttoncontainer.add_actor(this.buttons);

    this.container.add_actor(this.buttoncontainer);

    // add cweather and container to mainbox; in horizontal layout
    // cweather must not expand horizontally (it would stretch the icon)
    this.mainbox.add(this.cweather, { x_fill: false, y_fill: false, x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE, expand: false });
    this.mainbox.add(this.container, { x_fill: false, y_fill: true, x_align: St.Align.START, y_align: St.Align.MIDDLE, expand: true });
    this.window.add_actor(this.warningArea);
    this.window.add_actor(this.mainbox);

    this.setContent(this.window);
  },

  // Add the current time to the display
  _setLastUpdated: function () {
    this.currentTime = new Date();
    this.lastupdated = this.currentTime.toLocaleFormat('%c');
    if (this.bannerupdated) {
      // keep the existing actor: it may already have user-configured
      // styling applied by _update_style
      this.bannerupdated.label = this.lastupdated;
      if (this.updatedtooltip) this.updatedtooltip.set_text(_('Last updated'));
      return;
    }
    this.bannerupdated = new St.Button({ label: this.lastupdated, style: 'text-align: center;' });
    this.updatedtooltip = new Tooltips.Tooltip(this.bannerupdated, _('Last updated'));

    this._scheduleWidthCheck();
  },

  // Create a label without ellipsisation
  _createLabel: function (text) {
    let label = new St.Label({ text: text ? text : null });
    label.clutterText.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
  },

  // Called when styling needs updating
  updateStyle: function () {
    if (this._removed) return;
    this._setDerivedValues();
    this._update_style();
    this.displayCurrent();
    this.displayHourly();
    this.displayForecast();
    this.displayWarning();
    this.displayMeta();
    this._applyPinnedWidth();
  },

  // Keep the desklet width stable across display option changes: when a
  // width was pinned before a rebuild (see displayOptsChange and
  // metaOptsChange), fix the window to that width so adding or removing
  // rows never changes it. CSS min-width is NOT used here: on St widgets
  // re-applying it inflates the allocation (measured on Cinnamon 6.6 the
  // window width doubled with every toggle, growing without bound).
  // The actor's fixed width request allocates exactly the requested
  // width. The width is only fixed when the new content fits within the
  // captured width, so enabling wider rows can still grow the desklet
  // instead of clipping it; the pin is released by the next style pass
  // (e.g. zoom), which resets the window width before restyling.
  _applyPinnedWidth: function () {
    if (!(this._pinnedWidth > 0) || !this.window) return;
    let natural = this._pinnedWidth + 1;
    try {
      let pref = this.window.get_preferred_width(-1);
      natural = pref[1];
    } catch (e) {
      global.logError(e);
      return;
    }
    if (natural < this._pinnedWidth) {
      this.window.width = this._pinnedWidth;
    }
  },

  // Data-driven width adjustment: after the display functions updated the
  // label texts, the content may need more width than the pinned one.
  // Coalesced onto a single main-loop idle: the pin is released briefly
  // to measure the content's natural width, then the window grows to it
  // (raising the floor) when the data genuinely needs more room, or the
  // pinned width is restored otherwise. The width never shrinks below the
  // floor, so indicator toggles and ordinary data updates stay stable
  // while longer values are always shown completely.
  _scheduleWidthCheck: function () {
    if (this._removed || this._widthCheckPending) return;
    if (!this.window || this.window.width <= 0) return;
    this._widthCheckPending = true;
    Mainloop.idle_add(Lang.bind(this, function () {
      this._widthCheckPending = false;
      if (this._removed || !this.window) return false;
      let floor = this.window.width;
      if (floor <= 0) return false;
      let natural = 0;
      try {
        this.window.width = -1;
        let pref = this.window.get_preferred_width(-1);
        natural = pref[1];
      } catch (e) {
        global.logError(e);
        this.window.width = floor;
        return false;
      }
      if (natural > floor) {
        // the new data needs more room: grow to fit it completely
        this.window.width = natural;
      } else {
        this.window.width = floor;
      }
      return false;
    }));
  },

  // Called when measurement units change
  onUnitChange: function () {
    if (this._removed) return;
    this.displayCurrent();
    this.displayForecast();
    this.displayHourly();
  },

  // A display option changed: redraw the window
  displayOptsChange: function () {
    this.redrawNeeded = true;
    // debounce: when multiple display options change in quick succession
    // (e.g. the user toggles several checkboxes), only rebuild once
    if (this._redrawPending) return;
    this._redrawPending = true;
    Mainloop.timeout_add(200, Lang.bind(this, function () {
      this._redrawPending = false;
      if (this._removed) return;
      // pin the current window width so toggling indicators never changes
      // the desklet width: the window is rebuilt with a different set of
      // rows, whose captions/values have different natural widths
      this._pinnedWidth = (this.window && this.window.get_width() > 0) ? this.window.get_width() : -1;
      this.redraw();
      this._pinnedWidth = -1;
      // some display options gate the API requests (hourly forecast, air
      // quality, warnings): refetch so newly enabled sections are filled
      // immediately instead of waiting for the next periodic refresh
      this._refreshweathers();
    }));
  },

  // region/country/bold-city toggles only restyle existing content, but
  // they can change the text width: pin the window width around them too
  metaOptsChange: function () {
    if (this._removed) return;
    this._pinnedWidth = (this.window && this.window.get_width() > 0) ? this.window.get_width() : -1;
    this.updateStyle();
    this._pinnedWidth = -1;
  },

  // forecast days changed: redraw and refetch
  redrawRefetch: function () {
    if (this._removed) return;
    this.redrawNeeded = true;
    // keep the last known day count so the window is rebuilt at a stable
    // size; it only grows or shrinks once the refreshed data has arrived
    // (handled by displayForecast)
    this.redraw();
    this._refreshweathers();
  },

  // redraw the window without refetching data
  redraw: function () {
    if (this._removed) return;
    this._setDerivedValues();
    this._createWindow();
    this._update_style();
    this._applyPinnedWidth();
    this.displayCurrent();
    this.displayHourly();
    this.displayForecast();
    this.displayWarning();
    this.displayMeta();
  },

  // update the data and restart the refresh loop
  _refreshweathers: function () {
    // update the existing timestamp actor in place so the styling set by
    // _update_style is preserved
    this._setLastUpdated();

    this.service.refreshData(this);
    this._doLoop();
  },

  // restart the main loop
  _doLoop: function () {
    if (this._timeoutId) {
      Mainloop.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    this._timeoutId = Mainloop.timeout_add_seconds(this.refreshSec, Lang.bind(this, this._refreshweathers));
  },

  // Change the refresh period and restart the loop
  changeRefresh: function () {
    if (this._removed) return;
    this._setDerivedValues();
    this._doLoop();
  },

  // Update the hourly forecast strip
  displayHourly: function () {
    if (this._removed || !this.hourlytable) return;
    let hours = this.service.data.hours;
    // the strip follows the user setting, not the data: hiding it when a
    // request fails or is still in flight would make the desklet change
    // size by itself between refreshes
    let show = this.display__hourly;
    this.hourlytable.visible = show;
    if (this._hourlySepArea) this._hourlySepArea.visible = show;
    if (!show) return;

    for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
      let hour = hours[h];
      this.hlabels[h].text = (hour && hour.time) ? hour.time : '';
      if (hour && hour.icon) {
        this.hicons[h].set_child(this._getIconImage(hour.icon, QWX_HOURLY_ICON_HEIGHT * this.zoom));
      } else {
        this.hicons[h].set_child(null);
      }
      this.htemps[h].text = (hour) ? this._formatTemperature(hour.temperature, true) : '';
      if (hour) {
        // tooltip: condition, feels like, precipitation probability, wind
        let tt = (hour.weathertext || '') +
          '\n' + _('Feels like:') + ' ' + this._formatTemperature(hour.feelslike, true) +
          '\n' + _('Precipitation probability:') + ' ' + (hour.precip_prob === '' ? '-' : hour.precip_prob + '%') +
          '\n' + _('Wind:') + ' ' + this._formatWind(hour);
        this.htooltips[h].set_text(tt);
      }
    }

    this._scheduleWidthCheck();
  },

  // Update the display of the forecast data
  displayForecast: function () {
    if (this._removed || !this.fwtable) return;
    let days = this.service.data.days;

    // Keep the forecast table size in sync with the data actually
    // returned. This handles both directions: a subscription may limit the
    // API to fewer days than requested, and it may grow again on a later
    // refresh. The window must never be rebuilt in the middle of an update
    // cycle: the current conditions, hourly strip and warning banners are
    // populated by their own asynchronous callbacks, and rebuilding here
    // would destroy those actors and blank those sections until the next
    // refresh, making the desklet change size by itself and lose values.
    // Instead, defer one atomic redraw to the main loop; it recomputes the
    // layout and repopulates every section from the already fetched data.
    if (days.length > 0) {
      let targetNo = Math.min(this.userno, days.length);
      if (this.no !== targetNo) {
        this.actualDays = days.length;
        if (!this._rebuildPending) {
          this._rebuildPending = true;
          Mainloop.idle_add(Lang.bind(this, function () {
            this._rebuildPending = false;
            if (!this._removed) this.redraw();
            return false;
          }));
        }
        return;
      }
    }

    // make sure we don't iterate past the data we have
    let shown = Math.min(this.no, days.length > 0 ? days.length : this.no);

    for (let f = 0; f < shown; f++) {
      let day = days[f];
      if (!day) day = new Object();
      this.labels[f].text = (f === 0) ? _('Today') : ((this.daynames[day.day]) ? this.daynames[day.day] : '');
      let fwiconimage = this._getIconImage(day.icon, QWX_ICON_HEIGHT * this.zoom);
      this.fwicons[f].set_child(fwiconimage);
      let tt = (day.weathertext) ? day.weathertext : _('No Data Available');
      if (day.textNight && day.textNight != day.weathertext) tt += ' / ' + day.textNight;
      if (day.precip_prob !== '' && typeof day.precip_prob !== 'undefined') {
        tt += '\n' + _('Precipitation probability:') + ' ' + day.precip_prob + '%';
      }
      if (day.sunrise) tt += '\n' + _('Sunrise:') + ' ' + day.sunrise + '  ' + _('Sunset:') + ' ' + day.sunset;
      this.wxtooltip[f].set_text(tt);
      if (this.max[f]) this.max[f].text = this._formatTemperature(day.maximum_temperature, true);
      if (this.min[f]) this.min[f].text = this._formatTemperature(day.minimum_temperature, true);
      if (this.winds[f]) this.winds[f].text = this._formatWindValue(day.wind_speed, day.wind_scale, false);
      if (this.windd[f]) this.windd[f].text = (day.wind_direction) ? day.wind_direction : '';
      // GJS rejects numbers for GObject string properties: wrap in String()
      if (this.fuv[f]) this.fuv[f].text = (day.uv === '' || typeof day.uv === 'undefined') ? '' : String(Math.round(day.uv));
      if (this.fprecip[f]) this.fprecip[f].text = this._formatPrecip(day.precip);
    }

    if (this.service.data.status.forecast === SERVICE_STATUS_ERROR) {
      // forecast failed entirely: show the error in the first row
      if (this.labels[0]) {
        this.labels[0].text = (this.service.data.status.lasterror) ? _('Error: %s').format(this.service.data.status.lasterror) : _('No Data');
      }
    }

    this._scheduleWidthCheck();
  },

  // Update the display of the current observations
  displayCurrent: function () {
    if (this._removed) return;
    let cc = this.service.data.cc;

    if (this.cwicon) {
      let cwimage = this._getIconImage(cc.icon, QWX_CC_ICON_HEIGHT * this.zoom);
      this.cwicon.set_child(cwimage);
    }

    if (this.shifttemp) {
      if (this.weathertext) this.weathertext.text = (cc.weathertext) ? cc.weathertext : '';
      if (this.currenttemp) this.currenttemp.text = this._formatTemperature(cc.temperature, true);
    } else if (this.weathertext) {
      this.weathertext.text = ((cc.weathertext) ? cc.weathertext : '') +
        ((cc.has_temp && cc.weathertext) ? ', ' : '') +
        this._formatTemperature(cc.temperature, true);
    }

    if (this.feelslike) this.feelslike.text = this._formatTemperature(cc.feelslike, true);
    if (this.humidity) this.humidity.text = this._formatHumidity(cc.humidity);
    if (this.windspeed) this.windspeed.text = this._formatWind(cc);
    if (this.pressure) this.pressure.text = this._formatPressure(cc.pressure, true);
    if (this.visibility) this.visibility.text = this._formatVisibility(cc.visibility, true);
    if (this.precip) this.precip.text = this._formatPrecip(cc.precip);
    // GJS rejects numbers for GObject string properties: wrap in String()
    if (this.uv) this.uv.text = (cc.uv === '' || cc.uv === null || typeof cc.uv === 'undefined') ? '' : String(Math.round(cc.uv));

    // sunrise / sunset from today's forecast
    if (this.sunrise || this.sunset) {
      let today = this.service.data.days[0];
      if (this.sunrise) this.sunrise.text = (today && today.sunrise) ? today.sunrise : '';
      if (this.sunset) this.sunset.text = (today && today.sunset) ? today.sunset : '';
    }

    // air quality, coloured by AQI
    if (this.airquality) {
      let air = this.service.data.air;
      if (air.display !== '') {
        this.airquality.text = air.display + ' ' + air.category;
        this.airquality.style = 'text-align: left; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px; font-weight: bold; color: ' + (air.color ? air.color : this.textcolor);
        if (this.airqualitytooltip) {
          let tt = air.display + ' ' + air.category;
          if (air.primary && air.primary != 'NA' && air.primary != '-') tt += '\n' + _('Primary pollutant:') + ' ' + air.primary;
          this.airqualitytooltip.set_text(tt);
        }
      } else {
        this.airquality.text = '';
      }
    }

    if (this.service.data.status.cc === SERVICE_STATUS_ERROR && this.weathertext) {
      this.weathertext.text = (this.service.data.status.lasterror) ? _('Error: %s').format(this.service.data.status.lasterror) : _('No Data');
    }

    this._scheduleWidthCheck();
  },

  // Update the warning banners
  displayWarning: function () {
    if (this._removed || !this.warningArea) return;
    let warnings = this.service.data.warnings;
    // keep showing the last received warnings when a refresh fails
    // transiently, so the desklet does not shrink and grow by itself
    let show = this.display__warning && warnings.length > 0;
    this.warningArea.visible = show;
    if (!show) return;

    // rebuild the banners
    this.warningArea.destroy_all_children();
    for (let i = 0; i < warnings.length; i++) {
      let w = warnings[i];
      let button = new St.Button({
        reactive: true,
        track_hover: true,
        style: 'border-radius: ' + 6 * this.zoom + 'px; padding: ' + 4 * this.zoom + 'px ' + 8 * this.zoom + 'px;' +
          'font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px; font-weight: bold; color: #ffffff;' +
          (w.color ? ' background-color: ' + w.color + ';' : ' background-color: rgba(200,0,0,0.8);')
      });
      let box = new St.BoxLayout({ vertical: false, style: 'spacing: ' + 6 * this.zoom + 'px' });
      if (w.icon) {
        let iconimg = this._getIconImage(w.icon, QWX_ICON_HEIGHT * this.zoom);
        box.add(iconimg, { x_fill: false, y_fill: false, x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE, expand: false });
      }
      let label = this._createLabel(w.title);
      box.add(label, { x_fill: false, y_fill: false, x_align: St.Align.START, y_align: St.Align.MIDDLE, expand: false });
      button.set_child(box);
      let tt = w.title;
      if (w.sender) tt += '\n' + w.sender;
      if (w.start) tt += '\n' + w.start + (w.end ? ' ~ ' + w.end : '');
      if (w.text) tt += '\n\n' + w.text;
      new Tooltips.Tooltip(button, tt);
      this.warningArea.add_actor(button);
    }

    this._scheduleWidthCheck();
  },

  // Update the meta display: city name and links
  displayMeta: function () {
    if (this._removed || !this.cityname) return;
    this.displaycity = '';
    this.tooltiplocation = '';

    if (this.manuallocation && this.manuallocation.toString().length) {
      this.displaycity = this.manuallocation;
      this.tooltiplocation = this.manuallocation;
    } else if (this.service.data.city.toString().length) {
      this.displaycity = this.service.data.city;
      this.tooltiplocation = this.service.data.city;
      if (this.display__meta__region && this.service.data.region) {
        this.displaycity += ', ' + this.service.data.region;
      }
      if (this.display__meta__country && this.service.data.country) {
        this.displaycity += ', ' + this.service.data.country;
      }
    } else if (this.service.loc) {
      this.displaycity = this.service.loc.lon + ',' + this.service.loc.lat;
      this.tooltiplocation = this.displaycity;
    }

    this.cityname.text = this.displaycity;

    // click handlers for the credit link
    try {
      if (this.bannersig) this.banner.disconnect(this.bannersig);
      if (this.cwiconsig && this.cwicon) this.cwicon.disconnect(this.cwiconsig);
      this.bannersig = null;
      this.cwiconsig = null;
    } catch (e) { }
    this.bannersig = this.banner.connect('clicked', Lang.bind(this, function () {
      this.launcher.spawnv(['xdg-open', QWX_WEBSITE]);
    }));
    if (this.cwicon) {
      this.cwicontooltip.set_text(_('Click for the full forecast for %s').format(this.tooltiplocation));
      this.cwiconsig = this.cwicon.connect('clicked', Lang.bind(this, function () {
        this.launcher.spawnv(['xdg-open', QWX_WEBSITE]);
      }));
    }
    this.bannertooltip.set_text(_('Click for the full forecast for %s').format(this.tooltiplocation));

    if (this.service.data.status.meta === SERVICE_STATUS_ERROR) {
      this.cityname.text = (this.service.data.status.lasterror) ? _('Error: %s').format(this.service.data.status.lasterror) : _('No Data');
    }

    this._scheduleWidthCheck();
  },

  // Does the bulk of the work of updating style
  _update_style: function () {
    // release any width pinned by a previous display-option change so
    // this style pass (zoom, theme switch, ...) can resize freely; the
    // pin is re-applied afterwards via _applyPinnedWidth when one is due
    this.window.width = -1;
    this.mainbox.vertical = (this.vertical == 1) ? true : false;
    if (this.cwicon) {
      this.cwicon.height = QWX_CC_ICON_HEIGHT * this.zoom;
      this.cwicon.width = QWX_CC_ICON_HEIGHT * this.iconprops.aspect * this.zoom;
    }
    if (this.weathertext) this.weathertext.style = 'text-align: center; font-size: ' + QWX_CC_TEXT_SIZE * this.zoom + 'px';
    if (this.currenttemp) this.currenttemp.style = 'text-align: center; font-size: ' + this.currenttempsize * this.zoom + 'px';
    if (this.ctemp_bigtemp) this.ctemp_bigtemp.style = 'text-align: left; padding-right: ' + this.currenttempadding * this.zoom + 'px';
    this.fwtable.style = 'spacing-rows: ' + QWX_TABLE_ROW_SPACING * this.zoom + 'px; spacing-columns: ' + QWX_TABLE_COL_SPACING * this.zoom + 'px; padding: ' + QWX_TABLE_PADDING * this.zoom + 'px;';
    if (this.hourlytable) {
      this.hourlytable.style = 'spacing-rows: ' + QWX_TABLE_ROW_SPACING * this.zoom + 'px; spacing-columns: ' + QWX_TABLE_COL_SPACING * this.zoom + 'px; padding: ' + QWX_TABLE_PADDING * this.zoom + 'px;';
    }
    this.cityname.style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px; font-weight: ' + ((this.citystyle) ? 'bold' : 'normal') + ';';
    this.ccTable.style = 'spacing-rows: ' + QWX_TABLE_ROW_SPACING * this.zoom + 'px; spacing-columns: ' + QWX_LABEL_PADDING * this.zoom + 'px; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px;';

    if (this.overrideTheme) {
      // hide the header and use a style without a border
      this._header.hide();
      this.window.set_style_class_name('desklet');
      if (this.border) {
        let borderradius = (this.borderwidth > this.cornerradius) ? this.borderwidth : this.cornerradius;
        this.window.style = 'border: ' + this.borderwidth + 'px solid ' + this.bordercolor + '; border-radius: ' + borderradius + 'px; background-color: ' + (this.bgcolor.replace(')', ',' + this.transparency + ')')).replace('rgb', 'rgba') + '; color: ' + this.textcolor;
      } else {
        this.window.style = 'border-radius: ' + this.cornerradius + 'px; background-color: ' + (this.bgcolor.replace(')', ',' + this.transparency + ')')).replace('rgb', 'rgba') + '; color: ' + this.textcolor;
      }
      this.banner.style = 'font-size: ' + QWX_LINK_TEXT_SIZE * this.zoom + 'px; color: ' + this.textcolor;
      this.bannerupdated.style = 'font-size: ' + QWX_LINK_TEXT_SIZE * this.zoom + 'px; color: ' + this.textcolor;
      this.bannerpre.style = 'font-size: ' + QWX_LINK_TEXT_SIZE * this.zoom + 'px; color: ' + this.textcolor;
      if (this.textshadow) this.window.style = this.window.style + '; text-shadow: 1px 1px ' + this.shadowblur + 'px ' + contrastingColor(this.textcolor);
    } else {
      this.window.style = '';
      // style class and header visibility depend on the global desklet settings
      let dec = global.settings.get_int('desklet-decorations');
      switch (dec) {
        case 0:
          this._header.hide();
          this.window.set_style_class_name('desklet');
          break;
        case 1:
          this._header.hide();
          this.window.set_style_class_name('desklet-with-borders');
          break;
        case 2:
          this._header.show();
          this.window.set_style_class_name('desklet-with-borders-and-header');
          break;
      }
      this.banner.style = 'font-size: ' + QWX_LINK_TEXT_SIZE * this.zoom + 'px;';
      this.bannerupdated.style = 'font-size: ' + QWX_LINK_TEXT_SIZE * this.zoom + 'px;';
      this.bannerpre.style = 'font-size: ' + QWX_LINK_TEXT_SIZE * this.zoom + 'px;';
    }

    this._separatorArea.height = 5 * this.zoom;
    if (this._hourlySepArea) this._hourlySepArea.height = 5 * this.zoom;

    for (let f = 0; f < this.no; f++) {
      if (!this.labels[f]) continue;
      this.labels[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
      this.fwicons[f].height = QWX_ICON_HEIGHT * this.zoom;
      this.fwicons[f].width = QWX_ICON_HEIGHT * this.iconprops.aspect * this.zoom;
      if (this.max[f]) this.max[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
      if (this.min[f]) this.min[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
      if (this.winds[f]) this.winds[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
      if (this.windd[f]) this.windd[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
      if (this.fuv[f]) this.fuv[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
      if (this.fprecip[f]) this.fprecip[f].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
    }

    if (this.hourlytable) {
      for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
        this.hlabels[h].style = 'text-align: center; font-size: ' + QWX_LABEL_TEXT_SIZE * this.zoom + 'px';
        this.htemps[h].style = 'text-align: center; font-size: ' + QWX_TEXT_SIZE * this.zoom + 'px';
        this.hicons[h].height = QWX_HOURLY_ICON_HEIGHT * this.zoom;
        this.hicons[h].width = QWX_HOURLY_ICON_HEIGHT * this.iconprops.aspect * this.zoom;
      }
    }

    this.buttons.style = 'padding-top: ' + QWX_BUTTON_PADDING * this.zoom + 'px; padding-bottom: ' + QWX_BUTTON_PADDING * this.zoom + 'px';
    this.iconbutton.icon_size = QWX_REFRESH_ICON_SIZE * this.zoom;

    let forecastlabels = ['maxlabel', 'minlabel', 'windlabel', 'winddlabel', 'fuvlabel', 'fpreciplabel'];
    for (let i = 0; i < forecastlabels.length; i++) {
      if (this[forecastlabels[i]]) this[forecastlabels[i]].style = 'text-align: right; font-size: ' + QWX_LABEL_TEXT_SIZE * this.zoom + 'px';
    }

    this.cweather.style = 'padding: ' + QWX_CONTAINER_PADDING * this.zoom + 'px';
    if (this.vertical == 1) {
      this.container.style = 'padding: 0 ' + QWX_CONTAINER_PADDING * this.zoom + 'px ' + QWX_CONTAINER_PADDING * this.zoom + 'px ' + QWX_CONTAINER_PADDING * this.zoom + 'px ';
    } else {
      this.container.style = 'padding: ' + QWX_CONTAINER_PADDING * this.zoom + 'px';
    }
    this.warningArea.style = 'padding: ' + QWX_CONTAINER_PADDING * this.zoom + 'px ' + QWX_CONTAINER_PADDING * this.zoom + 'px 0 ' + QWX_CONTAINER_PADDING * this.zoom + 'px';
  },

  setGravity: function () {
    if (this._removed || !this.actor) return;
    if (this.experimental_enabled) {
      this.actor.move_anchor_point_from_gravity(this.gravity);
    } else {
      this.actor.move_anchor_point_from_gravity(0);
    }
  },

  // Get an icon image
  // -> iconcode: the QWeather icon code
  // -> h: the base height of the icon
  _getIconImage: function (iconcode, h) {
    if (typeof h === 'undefined') h = QWX_ICON_HEIGHT;
    let icon_name = '999';
    let icon_ext = '.' + this.iconprops.ext;
    if (iconcode) {
      icon_name = (typeof this.iconprops.map[iconcode] !== 'undefined') ? this.iconprops.map[iconcode] : iconcode;
    }
    let height = h * this.iconprops.adjust;
    let width = height * this.iconprops.aspect;
    let icon_file = this._deskletDir + '/icons/' + this.iconstyle + '/' + icon_name + icon_ext;
    let file = Gio.file_new_for_path(icon_file);
    if (!file.query_exists(null)) {
      // fall back to the default icon set
      icon_name = (typeof this.defaulticonprops.map[iconcode] !== 'undefined') ? this.defaulticonprops.map[iconcode] : iconcode;
      icon_file = this._deskletDir + '/icons/' + QWX_DEFAULT_ICONSET + '/' + icon_name + '.' + this.defaulticonprops.ext;
      height = h * this.defaulticonprops.adjust;
      width = height * this.defaulticonprops.aspect;
      file = Gio.file_new_for_path(icon_file);
      if (!file.query_exists(null)) {
        // ultimate fallback: the unknown icon
        icon_file = this._deskletDir + '/icons/' + QWX_DEFAULT_ICONSET + '/999.' + this.defaulticonprops.ext;
        file = Gio.file_new_for_path(icon_file);
      }
    }
    let icon_uri = file.get_uri();
    let iconimg = St.TextureCache.get_default().load_uri_async(icon_uri, width, height);
    // constrain the loaded texture to the requested size
    iconimg.set_size(width, height);
    return iconimg;
  },

  // ---- formatting functions --------------------------------------------
  // The driver returns: temperature C, wind speed km/h, pressure mb/hPa,
  // visibility km, precipitation mm, humidity %.

  _formatTemperature: function (temp, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof temp === 'undefined' || temp === null || temp === '') return '';
    if (!temp.toString().length) return '';
    let celsius = 1 * temp;
    let fahr = (celsius * 1.8) + 32;
    let out = Math.round((this.tunits == 'F') ? fahr : celsius);
    // temperature unit. %f is replaced by the value
    let fahrfmt = _('%f\u00b0F');
    let celfmt = _('%f\u00b0C');
    if (units) {
      out = (this.tunits == 'F') ? fahrfmt.format(out) : celfmt.format(out);
    }
    return out;
  },

  // wind speed value only (used in the forecast table)
  _formatWindValue: function (wind, scale, units) {
    if (this.windscale) {
      // Beaufort wind force. %s is replaced by the value
      if (scale === '' || typeof scale === 'undefined' || scale === null) return '';
      return _('Force %s').format(scale);
    }
    return this._formatWindspeed(wind, units);
  },

  // wind speed and direction (used for current conditions and tooltips)
  _formatWind: function (obj) {
    let dir = (obj.wind_direction) ? obj.wind_direction : '';
    let val = this._formatWindValue(obj.wind_speed, obj.wind_scale, true);
    if (dir && val) return dir + ' ' + val;
    return dir ? dir : val;
  },

  _formatWindspeed: function (wind, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof wind === 'undefined' || wind === null || wind === '') return '';
    let conversion = {
      'mph': 0.621,
      'knots': 0.54,
      'kph': 1,
      'mps': 0.278
    };
    // wind speed units. %f is replaced by the value
    let unitstring = {
      'mph': _('%fmph'),
      'knots': _('%fkn'),
      'kph': _('%fkm/h'),
      'mps': _('%fm/s')
    };
    let kph = 1 * wind;
    let out = kph * conversion[this.wunits];
    out = out.toFixed(0);
    if (units) {
      out = unitstring[this.wunits].format(out);
    }
    return out;
  },

  _formatPressure: function (pressure, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof pressure === 'undefined' || pressure === null || pressure === '') return '';
    let conversion = {
      'mb': 1,
      'in': 0.02953,
      'mm': 0.75,
      'kpa': 0.1
    };
    // pressure units. %f is replaced by the value
    let unitstring = {
      'mb': _('%fmb'),
      'in': _('%fin'),
      'mm': _('%fmm'),
      'kpa': _('%fkPa')
    };
    let precission = {
      'mb': 0,
      'in': 2,
      'mm': 0,
      'kpa': 1
    };
    let mb = 1 * pressure;
    let out = mb * conversion[this.punits];
    out = out.toFixed(precission[this.punits]);
    if (units) {
      out = unitstring[this.punits].format(out);
    }
    return out;
  },

  _formatHumidity: function (humidity) {
    if (typeof humidity === 'undefined' || humidity === null || humidity === '') return '';
    let out = 1 * humidity;
    out = out.toFixed(0);
    return out + '%';
  },

  _formatVisibility: function (vis, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof vis === 'undefined' || vis === null || vis === '') return '';
    // infer the desired units from the wind speed units
    let conversion = {
      'mph': 0.621,
      'knots': 0.54,
      'kph': 1,
      'mps': 1
    };
    // visibility units. %f is replaced by the value
    let unitstring = {
      'mph': _('%fmi'),
      'knots': _('%fnmi'),
      'kph': _('%fkm'),
      'mps': _('%fkm')
    };
    let km = 1 * vis;
    let out = km * conversion[this.wunits];
    let decpl = (out < 4) ? 1 : 0;
    out = out.toFixed(decpl);
    if (units) {
      out = unitstring[this.wunits].format(out);
    }
    return out;
  },

  // precipitation in mm
  _formatPrecip: function (precip) {
    if (typeof precip === 'undefined' || precip === null || precip === '') return '';
    let out = 1 * precip;
    out = out.toFixed(1);
    // precipitation amount in mm. %f is replaced by the value
    return _('%fmm').format(out);
  },

  on_desklet_removed: function () {
    if (this._timeoutId) {
      Mainloop.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._globalSettingsSignalId) {
      global.settings.disconnect(this._globalSettingsSignalId);
      this._globalSettingsSignalId = null;
    }
    // prevent any pending debounced redraw or rebuild from firing after removal
    this._redrawPending = false;
    this._rebuildPending = false;
    this._widthCheckPending = false;
    this._removed = true;
  }
};

// Choose an automatically contrasting black or white shadow colour
function contrastingColor(color) {
  return (luma(color) >= 165) ? '#000000' : '#ffffff';
}

function luma(color) {
  // SMPTE C, Rec. 709 weightings
  let hex = rgb2hex(color);
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4), 16);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgb2hex(rgb) {
  let match = ('' + rgb).match(/rgba?\(([^)]+)\)/i);
  if (!match) return '000000';
  let hex = match[1].split(',').slice(0, 3).map(function (hexCol) {
    hexCol = parseInt(hexCol).toString(16);
    return (hexCol.length == 1) ? '0' + hexCol : hexCol;
  });
  return hex.join('');
}

function main(metadata, desklet_id) {
  let desklet = new MyDesklet(metadata, desklet_id);
  return desklet;
}
