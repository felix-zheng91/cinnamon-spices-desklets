/*
 * qweather@felix - a Cinnamon desklet displaying weather from the
 * QWeather (和风天气) API.
 *
 * Stable-geometry UI redesign:
 * weather responses update content only. Layout geometry is derived from
 * user settings (layout, zoom, enabled sections and forecast day count).
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

let QWeather = null;
let SERVICE_STATUS_OK = 2;
let SERVICE_STATUS_ERROR = 0;

// Stable geometry constants. Only explicit user settings may change geometry.
const QWX_HORIZONTAL_WIDTH = 760;
const QWX_VERTICAL_WIDTH = 420;
const QWX_ROOT_PADDING = 12;
const QWX_SECTION_GAP = 10;
const QWX_INNER_GAP = 8;
const QWX_TEXT_SIZE = 14;
const QWX_CC_TEXT_SIZE = 34;
const QWX_WEATHER_TEXT_SIZE = 16;
const QWX_LABEL_TEXT_SIZE = 10;
const QWX_SECTION_TEXT_SIZE = 11;
const QWX_LINK_TEXT_SIZE = 10;
const QWX_REFRESH_ICON_SIZE = 14;
const QWX_CC_ICON_HEIGHT = 112;
const QWX_ICON_HEIGHT = 34;
const QWX_HOURLY_ICON_HEIGHT = 26;
const QWX_HOURLY_COUNT = 6;
const QWX_METRIC_HEIGHT = 50;
const QWX_NOTICE_HEIGHT = 32;
const QWX_HOURLY_HEIGHT = 86;
const QWX_FORECAST_ROW_HEIGHT = 46;
const QWX_FOOTER_HEIGHT = 28;
const QWX_DEFAULT_ICONSET = 'qweather';
const QWX_WEBSITE = 'https://www.qweather.com';
const QWX_CONSOLE = 'https://console.qweather.com';
const QWX_PLACEHOLDER = '—';

const ALIGN_CENTER = {
  x_fill: false,
  y_fill: false,
  x_align: St.Align.MIDDLE,
  y_align: St.Align.MIDDLE,
  expand: false
};

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
    this._deskletDir = metadata ? metadata.path : null;

    Desklet.Desklet.prototype._init.call(this, metadata);

    this._uuid = (metadata && metadata.uuid) ? metadata.uuid : UUID;
    if (this._uuid === UUID && metadata && metadata.path) {
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

    QWeather = imports.qweather;
    SERVICE_STATUS_OK = QWeather.SERVICE_STATUS_OK;
    SERVICE_STATUS_ERROR = QWeather.SERVICE_STATUS_ERROR;

    this.daynames = {
      Mon: _('Mon'), Tue: _('Tue'), Wed: _('Wed'), Thu: _('Thu'),
      Fri: _('Fri'), Sat: _('Sat'), Sun: _('Sun')
    };

    this._removed = false;
    this._timeoutId = null;
    this._structureTimerId = null;
    this._displayTimerId = null;
    this._globalSettingsSignalId = null;
    this.lastupdated = '';
    this.currentTime = null;

    this.metricValues = {};
    this.metricCaptions = {};
    this.metricTooltips = {};
    this.forecastRows = [];
    this.hourlySlots = [];

    try {
      this.settings = new Settings.DeskletSettings(this, this._uuid, this.desklet_id);

      // QWeather account and location.
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'apikey', 'apikey', this.changeService, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'apihost', 'apihost', this.changeService, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'location', 'location', this.changeService, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'lang', 'lang', this.changeService, null);

      // Units change text only, never geometry.
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'tunits', 'tunits', this.onUnitChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'wunits', 'wunits', this.onUnitChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'windscale', 'windscale', this.onUnitChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'punits', 'punits', this.onUnitChange, null);

      // Forecast day count changes structure and request size.
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'userno', 'userno', this.redrawRefetch, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'refreshtime', 'refreshtime', this.changeRefresh, null);

      // Display toggles change structure; some also gate API requests.
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

      // Geometry settings rebuild without forcing a network request.
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'zoom', 'zoom', this.structureChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'layout', 'layout', this.structureChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'iconstyle', 'iconstyle', this.iconStyleChange, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'citystyle', 'citystyle', this.metaOptsChange, null);

      // Theme settings restyle in place.
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

      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'manuallocation', 'manuallocation', this.displayMeta, null);

      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'experimental_enabled', 'experimental_enabled', this.setGravity, null);
      this.settings.bindProperty(Settings.BindingDirection.ONE_WAY, 'gravity', 'gravity', this.setGravity, null);

      this._globalSettingsSignalId = global.settings.connect(
        'changed::desklet-decorations',
        Lang.bind(this, this.updateStyle)
      );

      this.launcher = new Gio.SubprocessLauncher({
        flags: (
          Gio.SubprocessFlags.STDIN_PIPE |
          Gio.SubprocessFlags.STDOUT_PIPE |
          Gio.SubprocessFlags.STDERR_PIPE
        )
      });

      this.setHeader(_('Weather'));
      this._menu.addAction(_('QWeather console'), Lang.bind(this, function () {
        this.launcher.spawnv(['xdg-open', QWX_CONSOLE]);
      }));

      this.initForecast();
    } catch (e) {
      global.logError(e);
    }
    return true;
  },

  initForecast: function () {
    this.service = new QWeather.QWeather(this.apikey, this.apihost, this.location);
    this.service.setLang(this.lang);
    this._setDerivedValues();
    this._createWindow();
    this.setGravity();
    this._update_style();
    this.displayCurrent();
    this.displayHourly();
    this.displayForecast();
    this.displayWarning();
    this.displayMeta();
    this._refreshweathers();
  },

  changeService: function () {
    if (this._removed) return;
    this.initForecast();
  },

  _setDerivedValues: function () {
    this.vertical = this.layout;
    let requested = parseInt(this.userno, 10);
    if (isNaN(requested)) requested = 3;
    this.no = Math.max(1, Math.min(10, requested));

    this.service.setMaxDays(this.no);
    this.refreshSec = Math.max(this.refreshtime * 60, this.service.minTTL);
    this.service.wantHourly = this.display__hourly;
    this.service.wantAir = this.display__cc__aqi;
    this.service.wantWarning = this.display__warning;
    this.showweather = this.display__cc__weather;

    this._initIcons();
  },

  _initIcons: function () {
    this.iconprops = this._getIconMeta(this.iconstyle);
    this.defaulticonprops = this._getIconMeta(QWX_DEFAULT_ICONSET);
  },

  _getIconMeta: function (iconset) {
    let iconprops = {};
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
      if (typeof iconprops[prop] === 'undefined') iconprops[prop] = deficonprops[prop];
    }
    return iconprops;
  },

  _scale: function (value) {
    let zoom = 1 * this.zoom;
    if (!isFinite(zoom) || zoom <= 0) zoom = 1;
    return Math.max(1, Math.round(value * zoom));
  },

  _rootWidth: function () {
    return this._scale(this.vertical == 1 ? QWX_VERTICAL_WIDTH : QWX_HORIZONTAL_WIDTH);
  },

  _contentWidth: function () {
    return this._rootWidth() - (2 * this._scale(QWX_ROOT_PADDING));
  },

  _placeholder: function (value) {
    if (value === null || typeof value === 'undefined' || value === '') return QWX_PLACEHOLDER;
    return String(value);
  },

  _createBoundedLabel: function (text, width, styleClass, align) {
    let label = new St.Label({
      text: (text === null || typeof text === 'undefined') ? '' : String(text),
      style_class: styleClass || ''
    });
    label.width = Math.max(1, Math.round(width));
    label.clutterText.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutterText.set_single_line_mode(true);
    label._qweatherAlign = align || 'left';
    if (align === 'center') label.clutterText.set_line_alignment(Pango.Alignment.CENTER);
    else if (align === 'right') label.clutterText.set_line_alignment(Pango.Alignment.RIGHT);
    else label.clutterText.set_line_alignment(Pango.Alignment.LEFT);
    return label;
  },

  _setBoundedButtonLabel: function (button, width, align) {
    if (!button) return;
    button.width = Math.max(1, Math.round(width));
    let child = button.get_child ? button.get_child() : null;
    if (!child || !child.clutterText) return;
    child.width = Math.max(1, Math.round(width));
    child.clutterText.set_ellipsize(Pango.EllipsizeMode.END);
    child.clutterText.set_single_line_mode(true);
    child._qweatherAlign = align || 'left';
    if (align === 'center') child.clutterText.set_line_alignment(Pango.Alignment.CENTER);
    else if (align === 'right') child.clutterText.set_line_alignment(Pango.Alignment.RIGHT);
    else child.clutterText.set_line_alignment(Pango.Alignment.LEFT);
  },

  _setText: function (actor, value) {
    if (!actor) return;
    actor.text = this._placeholder(value);
  },

  _createMetricCell: function (captionText, valueVarName, width) {
    let cell = new St.BoxLayout({
      vertical: true,
      style_class: 'qweather-metric-cell'
    });
    cell.width = width;
    cell.height = this._scale(QWX_METRIC_HEIGHT);
    cell.style = 'padding: ' + this._scale(6) + 'px ' + this._scale(8) + 'px;';

    let caption = this._createBoundedLabel(
      captionText,
      width - this._scale(16),
      'qweather-metric-caption',
      'left'
    );
    let value = this._createBoundedLabel(
      QWX_PLACEHOLDER,
      width - this._scale(16),
      'qweather-metric-value',
      'left'
    );

    cell.add(caption, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });
    cell.add(value, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });

    this.metricCaptions[valueVarName] = caption;
    this.metricValues[valueVarName] = value;
    this[valueVarName] = value;
    this.metricTooltips[valueVarName] = new Tooltips.Tooltip(value);
    return cell;
  },

  _metricSpecs: function () {
    let specs = [];
    if (this.display__cc__feelslike) specs.push([_('Feels like'), 'feelslike']);
    if (this.display__cc__humidity) specs.push([_('Humidity'), 'humidity']);
    if (this.display__cc__wind_speed) specs.push([_('Wind'), 'windspeed']);
    if (this.display__cc__pressure) specs.push([_('Pressure'), 'pressure']);
    if (this.display__cc__aqi) specs.push([_('Air quality'), 'airquality']);
    if (this.display__cc__visibility) specs.push([_('Visibility'), 'visibility']);
    if (this.display__cc__precip) specs.push([_('Precipitation'), 'precip']);
    if (this.display__cc__uv) specs.push([_('UV index'), 'uv']);
    if (this.display__cc__sun) specs.push([_('Sunrise'), 'sunrise']);
    if (this.display__cc__sun) specs.push([_('Sunset'), 'sunset']);
    return specs;
  },

  _buildMetricGrid: function (width) {
    this.metricValues = {};
    this.metricCaptions = {};
    this.metricTooltips = {};
    let specs = this._metricSpecs();
    let grid = new St.Table({ style_class: 'qweather-metric-grid' });
    let gap = this._scale(QWX_INNER_GAP);
    let cellWidth = Math.floor((width - gap) / 2);
    grid.style = 'spacing-rows: ' + gap + 'px; spacing-columns: ' + gap + 'px;';

    for (let i = 0; i < specs.length; i++) {
      let cell = this._createMetricCell(specs[i][0], specs[i][1], cellWidth);
      grid.add(cell, {
        row: Math.floor(i / 2),
        col: i % 2,
        x_fill: false,
        y_fill: false,
        x_align: St.Align.START,
        y_align: St.Align.MIDDLE
      });
    }
    return grid;
  },

  _createWindow: function () {
    this._disconnectWindowSignals();

    if (this.window) {
      try {
        this.window.destroy_all_children();
      } catch (e) { }
    }

    this.metricValues = {};
    this.metricCaptions = {};
    this.metricTooltips = {};
    this.forecastRows = [];
    this.hourlySlots = [];

    let rootWidth = this._rootWidth();
    let contentWidth = this._contentWidth();
    let gap = this._scale(QWX_SECTION_GAP);
    let innerGap = this._scale(QWX_INNER_GAP);

    this.window = new St.BoxLayout({
      vertical: true,
      style_class: 'qweather-root'
    });
    this.window.width = rootWidth;
    this.window.style = 'spacing: ' + gap + 'px; padding: ' + this._scale(QWX_ROOT_PADDING) + 'px;';

    // Header: bounded location and bounded last-successful-update label.
    this.headerBox = new St.BoxLayout({
      vertical: false,
      style_class: 'qweather-header'
    });
    this.headerBox.width = contentWidth;
    this.headerBox.height = this._scale(28);
    this.headerBox.style = 'spacing: ' + innerGap + 'px;';

    let updatedWidth = this._scale(this.vertical == 1 ? 132 : 180);
    let cityWidth = contentWidth - updatedWidth - innerGap;

    this.cityname = this._createBoundedLabel('', cityWidth, 'qweather-city', 'left');
    this.citytooltip = new Tooltips.Tooltip(this.cityname);

    this.bannerupdated = new St.Button({
      label: this.lastupdated || QWX_PLACEHOLDER,
      style_class: 'qweather-updated'
    });
    this._setBoundedButtonLabel(this.bannerupdated, updatedWidth, 'right');
    this.updatedtooltip = new Tooltips.Tooltip(this.bannerupdated, _('Last updated'));

    this.headerBox.add(this.cityname, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.headerBox.add(this.bannerupdated, {
      x_fill: false, y_fill: false,
      x_align: St.Align.END, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.window.add_actor(this.headerBox);

    // Current weather card.
    this.currentCard = new St.BoxLayout({
      vertical: true,
      style_class: 'qweather-card qweather-current-card'
    });
    this.currentCard.width = contentWidth;
    this.currentCard.style = 'spacing: ' + innerGap + 'px; padding: ' + this._scale(10) + 'px;';

    this.currentContent = new St.BoxLayout({
      vertical: (this.vertical == 1),
      style_class: 'qweather-current-content'
    });
    this.currentContent.style = 'spacing: ' + innerGap + 'px;';

    let summaryWidth = (this.vertical == 1) ? contentWidth - this._scale(20) : this._scale(230);
    let metricsWidth = (this.vertical == 1)
      ? contentWidth - this._scale(20)
      : contentWidth - this._scale(20) - summaryWidth - innerGap;

    this.currentSummary = new St.BoxLayout({
      vertical: (this.vertical == 1),
      style_class: 'qweather-current-summary'
    });
    this.currentSummary.width = summaryWidth;
    this.currentSummary.style = 'spacing: ' + this._scale(6) + 'px;';

    if (this.showweather) {
      this.cwicon = new St.Button({
        style_class: 'qweather-current-icon'
      });
      this.cwicon.width = (this.vertical == 1) ? summaryWidth : this._scale(120);
      this.cwicon.height = this._scale(QWX_CC_ICON_HEIGHT);
      this.cwicontooltip = new Tooltips.Tooltip(this.cwicon);

      this.currentSummary.add(this.cwicon, {
        x_fill: false, y_fill: false,
        x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE,
        expand: false
      });
    } else {
      this.cwicon = null;
      this.cwicontooltip = null;
    }

    let summaryTextWidth = (this.vertical == 1)
      ? summaryWidth
      : Math.max(this._scale(90), summaryWidth - this._scale(126));

    this.summaryTextBox = new St.BoxLayout({
      vertical: true,
      style_class: 'qweather-current-text'
    });
    this.summaryTextBox.width = summaryTextWidth;
    this.summaryTextBox.style = 'spacing: ' + this._scale(2) + 'px;';

    this.currenttemp = this._createBoundedLabel(
      QWX_PLACEHOLDER,
      summaryTextWidth,
      'qweather-current-temp',
      'center'
    );
    this.weathertext = this._createBoundedLabel(
      QWX_PLACEHOLDER,
      summaryTextWidth,
      'qweather-current-description',
      'center'
    );
    this.weathertexttooltip = new Tooltips.Tooltip(this.weathertext);

    this.summaryTextBox.add(this.currenttemp, ALIGN_CENTER);
    if (this.showweather) this.summaryTextBox.add(this.weathertext, ALIGN_CENTER);

    this.currentSummary.add(this.summaryTextBox, {
      x_fill: false, y_fill: false,
      x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE,
      expand: false
    });

    this.currentContent.add(this.currentSummary, {
      x_fill: false, y_fill: false,
      x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE,
      expand: false
    });

    this.metricGrid = this._buildMetricGrid(metricsWidth);
    if (this._metricSpecs().length > 0) {
      this.currentContent.add(this.metricGrid, {
        x_fill: false, y_fill: false,
        x_align: St.Align.START, y_align: St.Align.MIDDLE,
        expand: false
      });
    }

    this.currentCard.add_actor(this.currentContent);
    this.window.add_actor(this.currentCard);

    // One persistent notice slot: API errors > weather warning > no-alert state.
    this.noticeButton = new St.Button({
      reactive: true,
      track_hover: true,
      style_class: 'qweather-notice qweather-notice-muted'
    });
    this.noticeButton.width = contentWidth;
    this.noticeButton.height = this._scale(QWX_NOTICE_HEIGHT);

    this.noticeBox = new St.BoxLayout({ vertical: false });
    this.noticeBox.width = contentWidth - this._scale(16);
    this.noticeBox.style = 'spacing: ' + innerGap + 'px;';

    let noticeCountWidth = this._scale(40);
    let noticeTextWidth = this.noticeBox.width - noticeCountWidth - innerGap;

    this.noticeLabel = this._createBoundedLabel(
      QWX_PLACEHOLDER,
      noticeTextWidth,
      'qweather-notice-text',
      'left'
    );
    this.noticeCount = this._createBoundedLabel(
      '',
      noticeCountWidth,
      'qweather-notice-count',
      'right'
    );
    this.noticeBox.add(this.noticeLabel, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.noticeBox.add(this.noticeCount, {
      x_fill: false, y_fill: false,
      x_align: St.Align.END, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.noticeButton.set_child(this.noticeBox);
    this.noticetooltip = new Tooltips.Tooltip(this.noticeButton);
    this.window.add_actor(this.noticeButton);

    // Hourly section: exactly six equal-width slots when enabled.
    if (this.display__hourly) {
      this.hourlySection = new St.BoxLayout({
        vertical: true,
        style_class: 'qweather-card qweather-section'
      });
      this.hourlySection.width = contentWidth;
      this.hourlySection.style = 'spacing: ' + this._scale(6) + 'px; padding: ' + this._scale(10) + 'px;';

      this.hourlyTitle = this._createBoundedLabel(
        _('Hourly'),
        contentWidth - this._scale(20),
        'qweather-section-title',
        'left'
      );
      this.hourlySection.add(this.hourlyTitle, {
        x_fill: false, y_fill: false,
        x_align: St.Align.START, y_align: St.Align.MIDDLE,
        expand: false
      });

      this.hourlyBox = new St.BoxLayout({
        vertical: false,
        style_class: 'qweather-hourly'
      });
      let hourlyContentWidth = contentWidth - this._scale(20);
      this.hourlyBox.width = hourlyContentWidth;
      this.hourlyBox.height = this._scale(QWX_HOURLY_HEIGHT);
      this.hourlyBox.style = 'spacing: ' + this._scale(4) + 'px;';

      let slotGap = this._scale(4);
      let slotWidth = Math.floor((hourlyContentWidth - slotGap * (QWX_HOURLY_COUNT - 1)) / QWX_HOURLY_COUNT);
      for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
        let slot = new St.BoxLayout({
          vertical: true,
          style_class: 'qweather-hourly-slot'
        });
        slot.width = slotWidth;
        slot.height = this._scale(QWX_HOURLY_HEIGHT);
        slot.style = 'spacing: ' + this._scale(2) + 'px; padding: ' + this._scale(4) + 'px;';

        let time = this._createBoundedLabel(
          QWX_PLACEHOLDER,
          slotWidth - this._scale(8),
          'qweather-hour-time',
          'center'
        );
        let icon = new St.Button({ style_class: 'qweather-hour-icon' });
        icon.width = slotWidth - this._scale(8);
        icon.height = this._scale(QWX_HOURLY_ICON_HEIGHT);
        let temp = this._createBoundedLabel(
          QWX_PLACEHOLDER,
          slotWidth - this._scale(8),
          'qweather-hour-temp',
          'center'
        );

        slot.add(time, ALIGN_CENTER);
        slot.add(icon, ALIGN_CENTER);
        slot.add(temp, ALIGN_CENTER);

        let tooltip = new Tooltips.Tooltip(icon);
        this.hourlySlots.push({
          box: slot,
          time: time,
          icon: icon,
          temp: temp,
          tooltip: tooltip
        });
        this.hourlyBox.add(slot, {
          x_fill: false, y_fill: false,
          x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE,
          expand: false
        });
      }

      this.hourlySection.add_actor(this.hourlyBox);
      this.window.add_actor(this.hourlySection);
    } else {
      this.hourlySection = null;
      this.hourlyBox = null;
    }

    // Daily forecast: one fixed row per configured day.
    this.forecastSection = new St.BoxLayout({
      vertical: true,
      style_class: 'qweather-card qweather-section'
    });
    this.forecastSection.width = contentWidth;
    this.forecastSection.style = 'spacing: ' + this._scale(4) + 'px; padding: ' + this._scale(10) + 'px;';

    this.forecastTitle = this._createBoundedLabel(
      _('Daily forecast'),
      contentWidth - this._scale(20),
      'qweather-section-title',
      'left'
    );
    this.forecastSection.add(this.forecastTitle, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });

    let rowWidth = contentWidth - this._scale(20);
    let rowGap = this._scale(6);
    let dayWidth = this._scale(58);
    let iconWidth = this._scale(42);
    let tempWidth = this._scale(100);
    let detailWidth = rowWidth - dayWidth - iconWidth - tempWidth - (rowGap * 3);

    for (let f = 0; f < this.no; f++) {
      let row = new St.BoxLayout({
        vertical: false,
        style_class: 'qweather-forecast-row'
      });
      row.width = rowWidth;
      row.height = this._scale(QWX_FORECAST_ROW_HEIGHT);
      row.style = 'spacing: ' + rowGap + 'px; padding: ' + this._scale(4) + 'px ' + this._scale(6) + 'px;';

      let day = this._createBoundedLabel(
        f === 0 ? _('Today') : QWX_PLACEHOLDER,
        dayWidth,
        'qweather-forecast-day',
        'left'
      );
      let icon = new St.Button({ style_class: 'qweather-forecast-icon' });
      icon.width = iconWidth;
      icon.height = this._scale(QWX_ICON_HEIGHT);
      let temp = this._createBoundedLabel(
        QWX_PLACEHOLDER,
        tempWidth,
        'qweather-forecast-temp',
        'center'
      );
      let detail = this._createBoundedLabel(
        QWX_PLACEHOLDER,
        detailWidth,
        'qweather-forecast-detail',
        'right'
      );

      row.add(day, {
        x_fill: false, y_fill: false,
        x_align: St.Align.START, y_align: St.Align.MIDDLE,
        expand: false
      });
      row.add(icon, ALIGN_CENTER);
      row.add(temp, ALIGN_CENTER);
      row.add(detail, {
        x_fill: false, y_fill: false,
        x_align: St.Align.END, y_align: St.Align.MIDDLE,
        expand: false
      });

      let tooltip = new Tooltips.Tooltip(icon);
      this.forecastRows.push({
        box: row,
        day: day,
        icon: icon,
        temp: temp,
        detail: detail,
        tooltip: tooltip
      });
      this.forecastSection.add_actor(row);
    }
    this.window.add_actor(this.forecastSection);

    // Footer: compact attribution + refresh. Attribution text is bounded.
    this.footerBox = new St.BoxLayout({
      vertical: false,
      style_class: 'qweather-footer'
    });
    this.footerBox.width = contentWidth;
    this.footerBox.height = this._scale(QWX_FOOTER_HEIGHT);
    this.footerBox.style = 'spacing: ' + this._scale(4) + 'px;';

    let refreshWidth = this._scale(30);
    let dataPreWidth = this._scale(64);
    let qweatherWidth = this._scale(72);
    let attributionWidth = contentWidth - refreshWidth - dataPreWidth - qweatherWidth - this._scale(12);

    this.bannerpre = this._createBoundedLabel(
      _('Data from '),
      dataPreWidth,
      'qweather-footer-meta',
      'left'
    );
    this.banner = new St.Button({
      label: 'QWeather',
      reactive: true,
      track_hover: true,
      style_class: 'qweather-link'
    });
    this._setBoundedButtonLabel(this.banner, qweatherWidth, 'left');

    this.bannerpost = new St.Button({
      label: ' ',
      style_class: 'qweather-footer-meta'
    });
    this._setBoundedButtonLabel(this.bannerpost, attributionWidth, 'left');

    this.iconbutton = new St.Icon({
      icon_name: 'view-refresh-symbolic',
      icon_type: St.IconType.SYMBOLIC
    });
    this.refreshbutton = new St.Button({
      style_class: 'qweather-refresh'
    });
    this.refreshbutton.width = refreshWidth;
    this.refreshbutton.height = this._scale(24);
    this.refreshbutton.set_child(this.iconbutton);

    this.bannertooltip = new Tooltips.Tooltip(this.banner);
    this.refreshtooltip = new Tooltips.Tooltip(this.refreshbutton, _('Refresh'));

    this.footerBox.add(this.bannerpre, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.footerBox.add(this.banner, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.footerBox.add(this.bannerpost, {
      x_fill: false, y_fill: false,
      x_align: St.Align.START, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.footerBox.add(this.refreshbutton, {
      x_fill: false, y_fill: false,
      x_align: St.Align.END, y_align: St.Align.MIDDLE,
      expand: false
    });
    this.window.add_actor(this.footerBox);

    this._connectWindowSignals();
    this.setContent(this.window);
  },

  _connectWindowSignals: function () {
    if (this.banner) {
      this.bannersig = this.banner.connect('clicked', Lang.bind(this, function () {
        this.launcher.spawnv(['xdg-open', QWX_WEBSITE]);
      }));
    }
    if (this.cwicon) {
      this.cwiconsig = this.cwicon.connect('clicked', Lang.bind(this, function () {
        this.launcher.spawnv(['xdg-open', QWX_WEBSITE]);
      }));
    }
    if (this.refreshbutton) {
      this.refreshsig = this.refreshbutton.connect('clicked', Lang.bind(this, this._refreshweathers));
    }
  },

  _disconnectWindowSignals: function () {
    try {
      if (this.bannersig && this.banner) this.banner.disconnect(this.bannersig);
      if (this.cwiconsig && this.cwicon) this.cwicon.disconnect(this.cwiconsig);
      if (this.refreshsig && this.refreshbutton) this.refreshbutton.disconnect(this.refreshsig);
    } catch (e) { }
    this.bannersig = null;
    this.cwiconsig = null;
    this.refreshsig = null;
  },

  _setLastUpdated: function () {
    this.currentTime = new Date();
    this.lastupdated = this.currentTime.toLocaleFormat('%c');
    if (this.bannerupdated) {
      this.bannerupdated.label = this.lastupdated;
      this._setBoundedButtonLabel(
        this.bannerupdated,
        this._scale(this.vertical == 1 ? 132 : 180),
        'right'
      );
      if (this.updatedtooltip) {
        this.updatedtooltip.set_text(_('Last updated') + ': ' + this.lastupdated);
      }
    }
  },

  updateStyle: function () {
    if (this._removed || !this.window) return;
    this._setDerivedValues();
    this._update_style();
    this.displayCurrent();
    this.displayHourly();
    this.displayForecast();
    this.displayWarning();
    this.displayMeta();
  },

  structureChange: function () {
    if (this._removed) return;
    if (this._structureTimerId) Mainloop.source_remove(this._structureTimerId);
    this._structureTimerId = Mainloop.timeout_add(120, Lang.bind(this, function () {
      this._structureTimerId = null;
      if (this._removed) return false;
      this.redraw();
      return false;
    }));
  },

  iconStyleChange: function () {
    if (this._removed) return;
    this._initIcons();
    this.displayCurrent();
    this.displayHourly();
    this.displayForecast();
  },

  onUnitChange: function () {
    if (this._removed) return;
    this.displayCurrent();
    this.displayForecast();
    this.displayHourly();
  },

  displayOptsChange: function () {
    if (this._removed) return;
    if (this._displayTimerId) Mainloop.source_remove(this._displayTimerId);
    this._displayTimerId = Mainloop.timeout_add(160, Lang.bind(this, function () {
      this._displayTimerId = null;
      if (this._removed) return false;
      this.redraw();
      this._refreshweathers();
      return false;
    }));
  },

  metaOptsChange: function () {
    if (this._removed) return;
    this._setDerivedValues();
    this._update_style();
    this.displayMeta();
  },

  redrawRefetch: function () {
    if (this._removed) return;
    this.redraw();
    this._refreshweathers();
  },

  redraw: function () {
    if (this._removed) return;
    this._setDerivedValues();
    this._createWindow();
    this._update_style();
    this.displayCurrent();
    this.displayHourly();
    this.displayForecast();
    this.displayWarning();
    this.displayMeta();
  },

  _refreshweathers: function () {
    if (this._removed || !this.service) return;
    this._setLastUpdated();
    this.service.refreshData(this);
    this._doLoop();
  },

  _doLoop: function () {
    if (this._timeoutId) {
      Mainloop.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    this._timeoutId = Mainloop.timeout_add_seconds(
      this.refreshSec,
      Lang.bind(this, this._refreshweathers)
    );
  },

  changeRefresh: function () {
    if (this._removed) return;
    this._setDerivedValues();
    this._doLoop();
  },

  displayHourly: function () {
    if (this._removed || !this.display__hourly || !this.hourlySlots.length) {
      this._updateNotice();
      return;
    }

    let hours = (this.service && this.service.data && this.service.data.hours)
      ? this.service.data.hours
      : [];

    for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
      let slot = this.hourlySlots[h];
      let hour = hours[h];

      slot.time.text = this._placeholder(hour && hour.time ? hour.time : '');
      slot.temp.text = this._placeholder(
        hour ? this._formatTemperature(hour.temperature, true) : ''
      );

      if (hour && hour.icon) {
        slot.icon.set_child(
          this._getIconImage(
            hour.icon,
            this._scale(QWX_HOURLY_ICON_HEIGHT),
            slot.icon.width
          )
        );
      } else {
        slot.icon.set_child(null);
      }

      if (hour) {
        let tt = (hour.weathertext || _('No Data Available')) +
          '\n' + _('Feels like:') + ' ' + this._placeholder(this._formatTemperature(hour.feelslike, true)) +
          '\n' + _('Precipitation probability:') + ' ' +
          (hour.precip_prob === '' ? QWX_PLACEHOLDER : hour.precip_prob + '%') +
          '\n' + _('Wind:') + ' ' + this._placeholder(this._formatWind(hour));
        slot.tooltip.set_text(tt);
      } else {
        slot.tooltip.set_text(_('No Data Available'));
      }
    }

    this._updateNotice();
  },

  displayForecast: function () {
    if (this._removed || !this.forecastRows.length) {
      this._updateNotice();
      return;
    }

    let days = (this.service && this.service.data && this.service.data.days)
      ? this.service.data.days
      : [];

    for (let f = 0; f < this.no; f++) {
      let row = this.forecastRows[f];
      let day = days[f];

      if (day) {
        row.day.text = (f === 0)
          ? _('Today')
          : (this.daynames[day.day] || this._placeholder(day.day));

        if (day.icon) {
          row.icon.set_child(
            this._getIconImage(
              day.icon,
              this._scale(QWX_ICON_HEIGHT),
              row.icon.width
            )
          );
        } else {
          row.icon.set_child(null);
        }

        row.temp.text = this._forecastTemperatureText(day);
        row.detail.text = this._forecastDetailText(day);

        let tt = day.weathertext || _('No Data Available');
        if (day.textNight && day.textNight !== day.weathertext) {
          tt += ' / ' + day.textNight;
        }
        if (day.precip_prob !== '' && typeof day.precip_prob !== 'undefined') {
          tt += '\n' + _('Precipitation probability:') + ' ' + day.precip_prob + '%';
        }
        if (day.sunrise) {
          tt += '\n' + _('Sunrise:') + ' ' + day.sunrise +
            '  ' + _('Sunset:') + ' ' + (day.sunset || QWX_PLACEHOLDER);
        }
        row.tooltip.set_text(tt);
      } else {
        row.day.text = (f === 0) ? _('Today') : QWX_PLACEHOLDER;
        row.icon.set_child(null);
        row.temp.text = QWX_PLACEHOLDER;
        row.detail.text = QWX_PLACEHOLDER;
        row.tooltip.set_text(_('No Data Available'));
      }
    }

    let today = days.length ? days[0] : null;
    this._setMetric('sunrise', today && today.sunrise ? today.sunrise : '');
    this._setMetric('sunset', today && today.sunset ? today.sunset : '');

    this._updateNotice();
  },

  _forecastTemperatureText: function (day) {
    let showMax = this.display__forecast__maximum_temperature;
    let showMin = this.display__forecast__minimum_temperature;
    if (!showMax && !showMin) return '';

    let max = showMax
      ? this._placeholder(this._formatTemperature(day.maximum_temperature, true))
      : '';
    let min = showMin
      ? this._placeholder(this._formatTemperature(day.minimum_temperature, true))
      : '';

    if (showMax && showMin) return max + ' / ' + min;
    if (showMax) return '↑ ' + max;
    return '↓ ' + min;
  },

  _forecastDetailText: function (day) {
    let parts = [];
    let hasAny =
      this.display__forecast__wind_speed ||
      this.display__forecast__wind_direction ||
      this.display__forecast__uv ||
      this.display__forecast__precip;
    if (!hasAny) return '';

    if (this.display__forecast__wind_speed || this.display__forecast__wind_direction) {
      let windParts = [];
      if (this.display__forecast__wind_direction && day.wind_direction) {
        windParts.push(day.wind_direction);
      }
      if (this.display__forecast__wind_speed) {
        let wind = this._formatWindValue(day.wind_speed, day.wind_scale, true);
        if (wind) windParts.push(wind);
      }
      parts.push(windParts.length ? windParts.join(' ') : QWX_PLACEHOLDER);
    }

    if (this.display__forecast__uv) {
      let uv = (day.uv === '' || day.uv === null || typeof day.uv === 'undefined')
        ? QWX_PLACEHOLDER
        : String(Math.round(day.uv));
      parts.push(_('UV') + ' ' + uv);
    }

    if (this.display__forecast__precip) {
      let precip = this._formatPrecip(day.precip);
      parts.push(precip || QWX_PLACEHOLDER);
    }

    return parts.join(' · ');
  },

  displayCurrent: function () {
    if (this._removed || !this.service || !this.service.data) return;

    let cc = this.service.data.cc || {};
    let air = this.service.data.air || {};

    if (this.cwicon) {
      if (cc.icon) {
        this.cwicon.set_child(
          this._getIconImage(
            cc.icon,
            this._scale(QWX_CC_ICON_HEIGHT),
            this.cwicon.width
          )
        );
      } else {
        this.cwicon.set_child(null);
      }
    }

    this.currenttemp.text = this._placeholder(
      this._formatTemperature(cc.temperature, true)
    );

    if (this.weathertext) {
      this.weathertext.text = this._placeholder(cc.weathertext);
      this.weathertexttooltip.set_text(cc.weathertext || _('No Data Available'));
    }

    this._setMetric('feelslike', this._formatTemperature(cc.feelslike, true));
    this._setMetric('humidity', this._formatHumidity(cc.humidity));
    this._setMetric('windspeed', this._formatWind(cc));
    this._setMetric('pressure', this._formatPressure(cc.pressure, true));
    this._setMetric('visibility', this._formatVisibility(cc.visibility, true));
    this._setMetric('precip', this._formatPrecip(cc.precip));

    let uv = (cc.uv === '' || cc.uv === null || typeof cc.uv === 'undefined')
      ? ''
      : String(Math.round(cc.uv));
    this._setMetric('uv', uv);

    let today = this.service.data.days && this.service.data.days.length
      ? this.service.data.days[0]
      : null;
    this._setMetric('sunrise', today && today.sunrise ? today.sunrise : '');
    this._setMetric('sunset', today && today.sunset ? today.sunset : '');

    if (this.airquality) {
      let airText = '';
      if (air.display !== '' && typeof air.display !== 'undefined') {
        airText = String(air.display);
        if (air.category) airText += ' ' + air.category;
      }
      this._setMetric('airquality', airText);

      let airColor = air.color ? air.color : this.textcolor;
      this.airquality.style =
        'font-size: ' + this._scale(QWX_TEXT_SIZE) + 'px;' +
        'font-weight: bold;' +
        (airColor ? 'color: ' + airColor + ';' : '');

      if (this.airqualitytooltip) {
        let tt = airText || _('No Data Available');
        if (air.primary && air.primary !== 'NA' && air.primary !== '-') {
          tt += '\n' + _('Primary pollutant:') + ' ' + air.primary;
        }
        this.airqualitytooltip.set_text(tt);
      }
    }

    this._updateNotice();
  },

  _setMetric: function (name, value) {
    let actor = this.metricValues[name];
    if (!actor) return;
    let text = this._placeholder(value);
    actor.text = text;
    if (this.metricTooltips[name]) this.metricTooltips[name].set_text(text);
  },

  displayWarning: function () {
    if (this._removed) return;
    this._updateNotice();
  },

  _activeErrors: function () {
    if (!this.service || !this.service.data || !this.service.data.errors) return [];
    let errors = this.service.data.errors;
    let entries = [];

    let add = function (enabled, key, label) {
      if (enabled && errors[key]) entries.push([label, errors[key]]);
    };

    add(true, 'meta', _('Location'));
    add(true, 'cc', _('Current weather'));
    add(true, 'forecast', _('Daily forecast'));
    add(this.display__hourly, 'hourly', _('Hourly forecast'));
    add(this.display__cc__aqi, 'air', _('Air quality'));
    add(this.display__warning, 'warning', _('Weather alerts'));

    return entries;
  },

  _warningTooltipText: function (warnings) {
    let lines = [];
    for (let i = 0; i < warnings.length; i++) {
      let w = warnings[i] || {};
      let line = w.title || _('Weather alert');
      if (w.sender) line += '\n' + w.sender;
      if (w.start) line += '\n' + w.start + (w.end ? ' ~ ' + w.end : '');
      if (w.text) line += '\n\n' + w.text;
      lines.push(line);
    }
    return lines.join('\n\n——\n\n');
  },

  _updateNotice: function () {
    if (!this.noticeButton || !this.noticeLabel || !this.noticeCount) return;

    let errors = this._activeErrors();
    if (errors.length) {
      this.noticeButton.set_style_class_name('qweather-notice qweather-notice-error');
      this.noticeButton.style = '';
      this.noticeLabel.text = _('Update failed');
      this.noticeCount.text = errors.length > 1 ? String(errors.length) : '';
      let details = [];
      for (let i = 0; i < errors.length; i++) {
        details.push(errors[i][0] + ': ' + errors[i][1]);
      }
      this.noticetooltip.set_text(details.join('\n'));
      return;
    }

    let warnings = (this.service && this.service.data && this.service.data.warnings)
      ? this.service.data.warnings
      : [];

    if (this.display__warning && warnings.length) {
      let w = warnings[0] || {};
      this.noticeButton.set_style_class_name('qweather-notice qweather-notice-warning');
      this.noticeButton.style =
        'background-color: ' + (w.color || 'rgba(190, 70, 45, 0.86)') + ';' +
        'color: #ffffff;';
      this.noticeLabel.text = w.title || _('Weather alert');
      this.noticeCount.text = warnings.length > 1 ? String(warnings.length) : '';
      this.noticetooltip.set_text(this._warningTooltipText(warnings));
      return;
    }

    this.noticeButton.set_style_class_name('qweather-notice qweather-notice-muted');
    this.noticeButton.style = '';
    this.noticeLabel.text = this.display__warning ? _('No active alerts') : QWX_PLACEHOLDER;
    this.noticeCount.text = '';
    this.noticetooltip.set_text(
      this.display__warning ? _('No active alerts') : _('Weather status')
    );
  },

  displayMeta: function () {
    if (this._removed || !this.cityname || !this.service) return;

    this.displaycity = '';
    this.tooltiplocation = '';

    if (this.manuallocation && this.manuallocation.toString().length) {
      this.displaycity = this.manuallocation.toString();
      this.tooltiplocation = this.displaycity;
    } else if (this.service.data.city && this.service.data.city.toString().length) {
      this.displaycity = this.service.data.city.toString();
      this.tooltiplocation = this.displaycity;

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

    this.cityname.text = this.displaycity || QWX_PLACEHOLDER;

    let cityTip = this.displaycity || _('No Data Available');
    if (this.service.data.errors && this.service.data.errors.meta) {
      cityTip += '\n' + this.service.data.errors.meta;
    }
    this.citytooltip.set_text(cityTip);

    let linkTip = _('Click for the full forecast for %s').format(
      this.tooltiplocation || this.displaycity || QWX_PLACEHOLDER
    );
    if (this.cwicontooltip) this.cwicontooltip.set_text(linkTip);
    if (this.bannertooltip) this.bannertooltip.set_text(linkTip);

    this._updateNotice();
  },

  _styleTextActor: function (actor, size, extra) {
    if (!actor) return;
    let align = actor._qweatherAlign || 'left';
    actor.style =
      'font-size: ' + this._scale(size) + 'px;' +
      'text-align: ' + align + ';' +
      (extra || '');
  },

  _styleButtonText: function (button, size, extra) {
    if (!button) return;
    let child = button.get_child ? button.get_child() : null;
    if (child) {
      let align = child._qweatherAlign || 'left';
      child.style =
        'font-size: ' + this._scale(size) + 'px;' +
        'text-align: ' + align + ';' +
        (extra || '');
    }
  },

  _update_style: function () {
    if (!this.window) return;

    this.window.width = this._rootWidth();

    if (this.overrideTheme) {
      if (this._header) this._header.hide();
      this.window.set_style_class_name('desklet qweather-root');

      let background = (this.bgcolor.replace(')', ',' + this.transparency + ')')).replace('rgb', 'rgba');
      let rootStyle =
        'padding: ' + this._scale(QWX_ROOT_PADDING) + 'px;' +
        'spacing: ' + this._scale(QWX_SECTION_GAP) + 'px;' +
        'background-color: ' + background + ';' +
        'color: ' + this.textcolor + ';';

      if (this.border) {
        let borderradius = (this.borderwidth > this.cornerradius)
          ? this.borderwidth
          : this.cornerradius;
        rootStyle +=
          'border: ' + this.borderwidth + 'px solid ' + this.bordercolor + ';' +
          'border-radius: ' + borderradius + 'px;';
      } else {
        rootStyle += 'border-radius: ' + this.cornerradius + 'px;';
      }

      if (this.textshadow) {
        rootStyle +=
          'text-shadow: 1px 1px ' + this.shadowblur + 'px ' +
          contrastingColor(this.textcolor) + ';';
      }
      this.window.style = rootStyle;
    } else {
      let dec = global.settings.get_int('desklet-decorations');
      switch (dec) {
        case 0:
          if (this._header) this._header.hide();
          this.window.set_style_class_name('desklet qweather-root');
          break;
        case 1:
          if (this._header) this._header.hide();
          this.window.set_style_class_name('desklet-with-borders qweather-root');
          break;
        case 2:
          if (this._header) this._header.show();
          this.window.set_style_class_name('desklet-with-borders-and-header qweather-root');
          break;
      }
      this.window.style =
        'padding: ' + this._scale(QWX_ROOT_PADDING) + 'px;' +
        'spacing: ' + this._scale(QWX_SECTION_GAP) + 'px;';
    }

    this._styleTextActor(
      this.cityname,
      QWX_TEXT_SIZE,
      'font-weight: ' + (this.citystyle ? 'bold' : 'normal') + ';'
    );
    this._styleButtonText(this.bannerupdated, QWX_LINK_TEXT_SIZE, '');
    this._styleTextActor(this.currenttemp, QWX_CC_TEXT_SIZE, 'font-weight: 600;');
    this._styleTextActor(this.weathertext, QWX_WEATHER_TEXT_SIZE, '');
    this._styleTextActor(this.hourlyTitle, QWX_SECTION_TEXT_SIZE, 'font-weight: bold;');
    this._styleTextActor(this.forecastTitle, QWX_SECTION_TEXT_SIZE, 'font-weight: bold;');
    this._styleTextActor(this.noticeLabel, QWX_TEXT_SIZE, '');
    this._styleTextActor(this.noticeCount, QWX_LABEL_TEXT_SIZE, 'font-weight: bold;');
    this._styleTextActor(this.bannerpre, QWX_LINK_TEXT_SIZE, '');
    this._styleButtonText(this.banner, QWX_LINK_TEXT_SIZE, '');
    this._styleButtonText(this.bannerpost, QWX_LINK_TEXT_SIZE, '');

    for (let key in this.metricValues) {
      let actor = this.metricValues[key];
      if (key !== 'airquality') this._styleTextActor(actor, QWX_TEXT_SIZE, 'font-weight: 600;');
    }

    for (let key in this.metricCaptions) {
      this._styleTextActor(this.metricCaptions[key], QWX_LABEL_TEXT_SIZE, '');
    }

    for (let h = 0; h < this.hourlySlots.length; h++) {
      this._styleTextActor(this.hourlySlots[h].time, QWX_LABEL_TEXT_SIZE, '');
      this._styleTextActor(this.hourlySlots[h].temp, QWX_TEXT_SIZE, 'font-weight: 600;');
    }

    for (let f = 0; f < this.forecastRows.length; f++) {
      this._styleTextActor(this.forecastRows[f].day, QWX_TEXT_SIZE, 'font-weight: 600;');
      this._styleTextActor(this.forecastRows[f].temp, QWX_TEXT_SIZE, 'font-weight: 600;');
      this._styleTextActor(this.forecastRows[f].detail, QWX_LABEL_TEXT_SIZE, '');
    }

    this.iconbutton.icon_size = this._scale(QWX_REFRESH_ICON_SIZE);

    // Re-apply AQI colour/font after theme changes.
    if (this.airquality && this.service && this.service.data) {
      let air = this.service.data.air || {};
      let airColor = air.color ? air.color : this.textcolor;
      this.airquality.style =
        'font-size: ' + this._scale(QWX_TEXT_SIZE) + 'px;' +
        'font-weight: bold;' +
        (airColor ? 'color: ' + airColor + ';' : '');
    }

    this._updateNotice();
  },

  setGravity: function () {
    if (this._removed || !this.actor) return;
    if (this.experimental_enabled) {
      this.actor.move_anchor_point_from_gravity(this.gravity);
    } else {
      this.actor.move_anchor_point_from_gravity(0);
    }
  },

  _getIconImage: function (iconcode, h, maxWidth) {
    if (typeof h === 'undefined') h = this._scale(QWX_ICON_HEIGHT);

    let icon_name = '999';
    let icon_ext = '.' + this.iconprops.ext;

    if (iconcode) {
      icon_name = (typeof this.iconprops.map[iconcode] !== 'undefined')
        ? this.iconprops.map[iconcode]
        : iconcode;
    }

    let height = h * this.iconprops.adjust;
    let width = height * this.iconprops.aspect;
    let icon_file = this._deskletDir + '/icons/' + this.iconstyle + '/' + icon_name + icon_ext;
    let file = Gio.file_new_for_path(icon_file);

    if (!file.query_exists(null)) {
      icon_name = (typeof this.defaulticonprops.map[iconcode] !== 'undefined')
        ? this.defaulticonprops.map[iconcode]
        : iconcode;
      icon_file =
        this._deskletDir + '/icons/' + QWX_DEFAULT_ICONSET + '/' +
        icon_name + '.' + this.defaulticonprops.ext;
      height = h * this.defaulticonprops.adjust;
      width = height * this.defaulticonprops.aspect;
      file = Gio.file_new_for_path(icon_file);

      if (!file.query_exists(null)) {
        icon_file =
          this._deskletDir + '/icons/' + QWX_DEFAULT_ICONSET +
          '/999.' + this.defaulticonprops.ext;
        file = Gio.file_new_for_path(icon_file);
      }
    }

    if (maxWidth && width > maxWidth) {
      let ratio = maxWidth / width;
      width = maxWidth;
      height = height * ratio;
    }

    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));

    let icon_uri = file.get_uri();
    let iconimg = St.TextureCache.get_default().load_uri_async(icon_uri, width, height);
    iconimg.set_size(width, height);
    return iconimg;
  },

  // ---- formatting functions --------------------------------------------

  _formatTemperature: function (temp, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof temp === 'undefined' || temp === null || temp === '') return '';
    if (!temp.toString().length) return '';

    let celsius = 1 * temp;
    let fahr = (celsius * 1.8) + 32;
    let out = Math.round((this.tunits == 'F') ? fahr : celsius);
    let fahrfmt = _('%f\u00b0F');
    let celfmt = _('%f\u00b0C');

    if (units) {
      out = (this.tunits == 'F') ? fahrfmt.format(out) : celfmt.format(out);
    }
    return out;
  },

  _formatWindValue: function (wind, scale, units) {
    if (this.windscale) {
      if (scale === '' || typeof scale === 'undefined' || scale === null) return '';
      return _('Force %s').format(scale);
    }
    return this._formatWindspeed(wind, units);
  },

  _formatWind: function (obj) {
    if (!obj) return '';
    let dir = obj.wind_direction ? obj.wind_direction : '';
    let val = this._formatWindValue(obj.wind_speed, obj.wind_scale, true);
    if (dir && val) return dir + ' ' + val;
    return dir ? dir : val;
  },

  _formatWindspeed: function (wind, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof wind === 'undefined' || wind === null || wind === '') return '';

    let conversion = {
      mph: 0.621,
      knots: 0.54,
      kph: 1,
      mps: 0.278
    };
    let unitstring = {
      mph: _('%fmph'),
      knots: _('%fkn'),
      kph: _('%fkm/h'),
      mps: _('%fm/s')
    };

    let kph = 1 * wind;
    let out = (kph * conversion[this.wunits]).toFixed(0);
    if (units) out = unitstring[this.wunits].format(out);
    return out;
  },

  _formatPressure: function (pressure, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof pressure === 'undefined' || pressure === null || pressure === '') return '';

    let conversion = {
      mb: 1,
      in: 0.02953,
      mm: 0.75,
      kpa: 0.1
    };
    let unitstring = {
      mb: _('%fmb'),
      in: _('%fin'),
      mm: _('%fmm'),
      kpa: _('%fkPa')
    };
    let precision = {
      mb: 0,
      in: 2,
      mm: 0,
      kpa: 1
    };

    let mb = 1 * pressure;
    let out = (mb * conversion[this.punits]).toFixed(precision[this.punits]);
    if (units) out = unitstring[this.punits].format(out);
    return out;
  },

  _formatHumidity: function (humidity) {
    if (typeof humidity === 'undefined' || humidity === null || humidity === '') return '';
    return (1 * humidity).toFixed(0) + '%';
  },

  _formatVisibility: function (vis, units) {
    units = typeof units !== 'undefined' ? units : false;
    if (typeof vis === 'undefined' || vis === null || vis === '') return '';

    let conversion = {
      mph: 0.621,
      knots: 0.54,
      kph: 1,
      mps: 1
    };
    let unitstring = {
      mph: _('%fmi'),
      knots: _('%fnmi'),
      kph: _('%fkm'),
      mps: _('%fkm')
    };

    let km = 1 * vis;
    let out = km * conversion[this.wunits];
    let decpl = (out < 4) ? 1 : 0;
    out = out.toFixed(decpl);
    if (units) out = unitstring[this.wunits].format(out);
    return out;
  },

  _formatPrecip: function (precip) {
    if (typeof precip === 'undefined' || precip === null || precip === '') return '';
    return _('%fmm').format((1 * precip).toFixed(1));
  },

  on_desklet_removed: function () {
    if (this._timeoutId) {
      Mainloop.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._structureTimerId) {
      Mainloop.source_remove(this._structureTimerId);
      this._structureTimerId = null;
    }
    if (this._displayTimerId) {
      Mainloop.source_remove(this._displayTimerId);
      this._displayTimerId = null;
    }
    if (this._globalSettingsSignalId) {
      global.settings.disconnect(this._globalSettingsSignalId);
      this._globalSettingsSignalId = null;
    }

    this._disconnectWindowSignals();
    this._removed = true;
  }
};

function contrastingColor(color) {
  return (luma(color) >= 165) ? '#000000' : '#ffffff';
}

function luma(color) {
  let hex = rgb2hex(color);
  let r = parseInt(hex.slice(0, 2), 16);
  let g = parseInt(hex.slice(2, 4), 16);
  let b = parseInt(hex.slice(4, 6), 16);
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
  return new MyDesklet(metadata, desklet_id);
}
