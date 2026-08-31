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
const QWX_BASE_WIDTH = 340;
const QWX_ROOT_PAD_X = 12;
const QWX_ROOT_PAD_TOP = 10;
const QWX_HOURLY_COUNT = 6;
const QWX_METRIC_COLUMNS = 3;
const QWX_METRIC_ROWS = 2;
const QWX_CURRENT_ICON = 56;
const QWX_HOURLY_ICON = 22;
const QWX_DAILY_ICON = 22;
const QWX_DEFAULT_ICONSET = 'qweather';
const QWX_PLACEHOLDER = '—';
const QWX_WEBSITE = 'https://www.qweather.com';
const QWX_CONSOLE = 'https://console.qweather.com';

let QWeather = null;
let UIV2 = null;

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');
function _(s) { return s ? Gettext.dgettext(UUID, s) : s; }
function MyDesklet(metadata, desklet_id) { this._init(metadata, desklet_id); }

MyDesklet.prototype = {
  __proto__: Desklet.Desklet.prototype,

  _init: function (metadata, desklet_id) {
    Desklet.Desklet.prototype._init.call(this, metadata);
    this.metadata = metadata;
    this.desklet_id = desklet_id;
    this._uuid = metadata && metadata.uuid ? metadata.uuid : UUID;
    this._deskletDir = metadata && metadata.path ? metadata.path : '';
    if (this._deskletDir && imports.searchPath.indexOf(this._deskletDir) === -1) imports.searchPath.push(this._deskletDir);
    QWeather = imports.qweather;
    UIV2 = imports.uiv2;

    this._removed = false;
    this._timeoutId = null;
    this._structureTimerId = null;
    this._globalSettingsSignalId = null;
    this.lastupdated = '';
    this.currentTime = null;
    this.hourlySlots = [];
    this.dailyRows = [];
    this.metricCells = [];

    try {
      this.settings = new Settings.DeskletSettings(this, this._uuid, this.desklet_id);
      this._bindSettings();
      this.launcher = new Gio.SubprocessLauncher({ flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE });
      this.setHeader(this._ui('Daily forecast'));
      this._menu.addAction(_('QWeather console'), Lang.bind(this, function () { this.launcher.spawnv(['xdg-open', QWX_CONSOLE]); }));
      this._globalSettingsSignalId = global.settings.connect('changed::desklet-decorations', Lang.bind(this, this.updateStyle));
      this.initForecast();
    } catch (e) { global.logError(e); }
  },

  _bindSettings: function () {
    let one = Settings.BindingDirection.ONE_WAY;
    let bi = Settings.BindingDirection.BIDIRECTIONAL;
    let b = Lang.bind(this, function (key, prop, cb, dir) { this.settings.bindProperty(dir || one, key, prop, cb, null); });
    b('apikey', 'apikey', this.changeService); b('apihost', 'apihost', this.changeService); b('location', 'location', this.changeService); b('lang', 'lang', this.changeService);
    b('tunits', 'tunits', this.onUnitChange); b('wunits', 'wunits', this.onUnitChange); b('windscale', 'windscale', this.onUnitChange); b('punits', 'punits', this.onUnitChange);
    b('userno', 'userno', this.redrawRefetch); b('refreshtime', 'refreshtime', this.changeRefresh);
    b('display__cc__weather', 'display__cc__weather', this.displayOptsChange); b('display__cc__feelslike', 'display__cc__feelslike', this.displayOptsChange);
    b('display__cc__humidity', 'display__cc__humidity', this.displayOptsChange); b('display__cc__wind_speed', 'display__cc__wind_speed', this.displayOptsChange);
    b('display__cc__pressure', 'display__cc__pressure', this.displayOptsChange); b('display__cc__visibility', 'display__cc__visibility', this.displayOptsChange);
    b('display__cc__precip', 'display__cc__precip', this.displayOptsChange); b('display__cc__aqi', 'display__cc__aqi', this.displayOptsChange);
    b('display__cc__uv', 'display__cc__uv', this.displayOptsChange); b('display__cc__sun', 'display__cc__sun', this.displayOptsChange);
    b('display__hourly', 'display__hourly', this.displayOptsChange); b('display__warning', 'display__warning', this.displayOptsChange);
    b('display__forecast__maximum_temperature', 'display__forecast__maximum_temperature', this.displayOptsChange);
    b('display__forecast__minimum_temperature', 'display__forecast__minimum_temperature', this.displayOptsChange);
    b('display__forecast__wind_speed', 'display__forecast__wind_speed', this.displayOptsChange); b('display__forecast__wind_direction', 'display__forecast__wind_direction', this.displayOptsChange);
    b('display__forecast__uv', 'display__forecast__uv', this.displayOptsChange); b('display__forecast__precip', 'display__forecast__precip', this.displayOptsChange);
    b('display__meta__region', 'display__meta__region', this.displayMeta); b('display__meta__country', 'display__meta__country', this.displayMeta);
    b('zoom', 'zoom', this.structureChange); b('layout', 'layout', this.structureChange); b('iconstyle', 'iconstyle', this.iconStyleChange); b('citystyle', 'citystyle', this.displayMeta);
    b('overrideTheme', 'overrideTheme', this.updateStyle); b('transparency', 'transparency', this.updateStyle, bi); b('textcolor', 'textcolor', this.updateStyle);
    b('textshadow', 'textshadow', this.updateStyle); b('shadowblur', 'shadowblur', this.updateStyle); b('bgcolor', 'bgcolor', this.updateStyle);
    b('cornerradius', 'cornerradius', this.updateStyle); b('border', 'border', this.updateStyle); b('bordercolor', 'bordercolor', this.updateStyle); b('borderwidth', 'borderwidth', this.updateStyle);
    b('manuallocation', 'manuallocation', this.displayMeta); b('experimental_enabled', 'experimental_enabled', this.setGravity); b('gravity', 'gravity', this.setGravity);
  },

  _ui: function (key) { return UIV2 && UIV2.uiText ? UIV2.uiText(this.lang || 'auto', GLib.get_language_names(), key) : (_(key) || key); },
  _scale: function (n) { let z = Number(this.zoom); if (!isFinite(z) || z <= 0) z = 1; return Math.max(1, Math.round(n * z)); },
  _rootWidth: function () { return this._scale(QWX_BASE_WIDTH); },
  _contentWidth: function () { return this._rootWidth() - this._scale(QWX_ROOT_PAD_X * 2); },
  _placeholder: function (v) { return (v === null || typeof v === 'undefined' || v === '') ? QWX_PLACEHOLDER : String(v); },

  initForecast: function () {
    this.service = new QWeather.QWeather(this.apikey, this.apihost, this.location);
    this.service.setLang(this.lang);
    this._setDerivedValues();
    this._createWindow();
    this.updateStyle();
    this.setGravity();
    this.displayCurrent(); this.displayHourly(); this.displayForecast(); this.displayWarning(); this.displayMeta();
    this._refreshweathers();
  },

  _setDerivedValues: function () {
    let n = parseInt(this.userno, 10); if (isNaN(n)) n = 7; this.no = Math.max(1, Math.min(10, n));
    this.service.setMaxDays(this.no);
    this.refreshSec = Math.max(Number(this.refreshtime || 10) * 60, this.service.minTTL);
    this.service.wantHourly = !!this.display__hourly;
    this.service.wantAir = !!this.display__cc__aqi;
    this.service.wantWarning = !!this.display__warning;
    this._initIcons();
  },

  _initIcons: function () { this.iconprops = this._getIconMeta(this.iconstyle); this.defaulticonprops = this._getIconMeta(QWX_DEFAULT_ICONSET); },
  _getIconMeta: function (iconset) {
    let out = { aspect: 1, adjust: 1, ext: 'png', map: {} };
    try {
      let raw = GLib.file_get_contents(this._deskletDir + '/icons/' + iconset + '/iconmeta.json')[1];
      let parsed = JSON.parse(ByteArray.toString(raw)); for (let k in out) if (typeof parsed[k] === 'undefined') parsed[k] = out[k]; out = parsed;
    } catch (e) { global.logError(e); }
    return out;
  },

  _boundedLabel: function (text, width, styleClass, align) {
    let l = new St.Label({ text: this._placeholder(text), style_class: styleClass || '' });
    l.width = Math.max(1, Math.round(width));
    l.clutterText.set_single_line_mode(true); l.clutterText.set_ellipsize(Pango.EllipsizeMode.END);
    if (align === 'center') l.clutterText.set_line_alignment(Pango.Alignment.CENTER);
    else if (align === 'right') l.clutterText.set_line_alignment(Pango.Alignment.RIGHT);
    return l;
  },

  _iconHolder: function (boxWidth, boxHeight, styleClass) {
    let holder = new St.Button({ style_class: styleClass || '' }); holder.width = boxWidth; holder.height = boxHeight;
    let box = new St.Bin({ x_fill: false, y_fill: false, x_align: St.Align.MIDDLE, y_align: St.Align.MIDDLE });
    box.width = boxWidth; box.height = boxHeight; holder.set_child(box); holder._qweatherBin = box; return holder;
  },

  _setIcon: function (holder, code, height) {
    if (!holder || !holder._qweatherBin) return;
    holder._qweatherBin.set_child(code ? this._getIconImage(code, height, holder.width) : null);
  },

  _getIconImage: function (iconcode, h, maxWidth) {
    let props = this.iconprops; let iconName = iconcode || '999'; let mapped = props.map && typeof props.map[iconName] !== 'undefined' ? props.map[iconName] : iconName;
    let file = Gio.file_new_for_path(this._deskletDir + '/icons/' + this.iconstyle + '/' + mapped + '.' + props.ext);
    if (!file.query_exists(null)) { props = this.defaulticonprops; mapped = props.map && typeof props.map[iconName] !== 'undefined' ? props.map[iconName] : iconName; file = Gio.file_new_for_path(this._deskletDir + '/icons/' + QWX_DEFAULT_ICONSET + '/' + mapped + '.' + props.ext); }
    if (!file.query_exists(null)) file = Gio.file_new_for_path(this._deskletDir + '/icons/' + QWX_DEFAULT_ICONSET + '/999.' + this.defaulticonprops.ext);
    let d = UIV2.iconDimensions(h, props.aspect, props.adjust); let w = d.width; let hh = d.height;
    if (maxWidth && w > maxWidth) { let r = maxWidth / w; w *= r; hh *= r; }
    w = Math.max(1, Math.round(w)); hh = Math.max(1, Math.round(hh));
    let img = St.TextureCache.get_default().load_uri_async(file.get_uri(), w, hh); img.set_size(w, hh); return img;
  },

  _createMetricCell: function (width) {
    let cell = new St.BoxLayout({ vertical: true, style_class: 'qweather-metric' }); cell.width = width; cell.height = this._scale(50);
    let k = this._boundedLabel('', width - this._scale(8), 'qweather-metric-k', 'center'); let v = this._boundedLabel('', width - this._scale(8), 'qweather-metric-v', 'center');
    cell.add(k, { x_fill: false, x_align: St.Align.MIDDLE }); cell.add(v, { x_fill: false, x_align: St.Align.MIDDLE }); return { box: cell, key: k, value: v };
  },

  _metricSpecs: function () {
    let cc = this.service && this.service.data ? (this.service.data.cc || {}) : {}; let air = this.service && this.service.data ? (this.service.data.air || {}) : {};
    let specs = [];
    if (this.display__cc__humidity) specs.push([this._ui('Humidity'), this._formatHumidity(cc.humidity)]);
    if (this.display__cc__wind_speed) specs.push([this._ui('Wind'), this._formatWind(cc)]);
    if (this.display__cc__uv) specs.push([this._ui('UV index'), cc.uv === '' ? '' : String(Math.round(cc.uv))]);
    if (this.display__cc__pressure) specs.push([this._ui('Pressure'), this._formatPressure(cc.pressure, true)]);
    if (this.display__cc__visibility) specs.push([this._ui('Visibility'), this._formatVisibility(cc.visibility, true)]);
    if (this.display__cc__precip) specs.push([this._ui('Precipitation'), this._formatPrecip(cc.precip)]);
    if (this.display__cc__aqi) specs.push([this._ui('Air quality'), air.display ? String(air.display) + (air.category ? ' ' + air.category : '') : '']);
    let today = this.service && this.service.data && this.service.data.days ? this.service.data.days[0] : null;
    if (this.display__cc__sun) specs.push([this._ui('Sunrise'), today ? today.sunrise : '']);
    if (this.display__cc__sun) specs.push([this._ui('Sunset'), today ? today.sunset : '']);
    if (this.display__cc__feelslike) specs.push([this._ui('Feels like'), this._formatTemperature(cc.feelslike, true)]);
    return specs.slice(0, QWX_METRIC_COLUMNS * QWX_METRIC_ROWS);
  },

  _createWindow: function () {
    if (this.window) try { this.window.destroy_all_children(); } catch (e) {}
    this.hourlySlots = []; this.dailyRows = []; this.metricCells = [];
    let w = this._contentWidth(); let gap = this._scale(6);
    this.window = new St.BoxLayout({ vertical: true, style_class: 'qweather-root' }); this.window.width = this._rootWidth();
    this.window.style = 'padding: ' + this._scale(QWX_ROOT_PAD_TOP) + 'px ' + this._scale(QWX_ROOT_PAD_X) + 'px ' + this._scale(12) + 'px; spacing: ' + this._scale(8) + 'px;';

    this.alertBox = new St.BoxLayout({ vertical: true, style_class: 'qweather-alert' }); this.alertBox.width = w;
    this.alertTitle = this._boundedLabel('', w - this._scale(20), 'qweather-alert-title', 'left'); this.alertBody = this._boundedLabel('', w - this._scale(20), 'qweather-alert-body', 'left');
    this.alertBox.add(this.alertTitle); this.alertBox.add(this.alertBody); this.alertBox.hide(); this.window.add_actor(this.alertBox);

    this.topBox = new St.BoxLayout({ vertical: false, style_class: 'qweather-top' }); this.topBox.width = w;
    this.bannerupdated = new St.Button({ label: '', style_class: 'qweather-updated' }); this.bannerupdated.width = w - this._scale(82);
    this.refreshbutton = new St.Button({ label: '↻ ' + this._ui('Refresh'), style_class: 'qweather-refresh' }); this.refreshbutton.width = this._scale(76);
    this.topBox.add(this.bannerupdated, { x_fill: false, x_align: St.Align.START }); this.topBox.add(this.refreshbutton, { x_fill: false, x_align: St.Align.END }); this.window.add_actor(this.topBox);

    this.currentBox = new St.BoxLayout({ vertical: false, style_class: 'qweather-current' }); this.currentBox.width = w;
    let leftW = w - this._scale(86); let rightW = this._scale(76);
    this.currentLeft = new St.BoxLayout({ vertical: true }); this.currentLeft.width = leftW;
    this.currenttemp = this._boundedLabel('', leftW, 'qweather-temp', 'left'); this.weathertext = this._boundedLabel('', leftW, 'qweather-cond', 'left'); this.hilo = this._boundedLabel('', leftW, 'qweather-hilo', 'left');
    this.currentLeft.add(this.currenttemp); this.currentLeft.add(this.weathertext); this.currentLeft.add(this.hilo);
    this.currentRight = new St.BoxLayout({ vertical: true, style_class: 'qweather-current-right' }); this.currentRight.width = rightW;
    this.cwicon = this._iconHolder(rightW, this._scale(58), 'qweather-current-icon'); this.feels = this._boundedLabel('', rightW, 'qweather-feels', 'right');
    this.currentRight.add(this.cwicon, { x_fill: false, x_align: St.Align.END }); this.currentRight.add(this.feels, { x_fill: false, x_align: St.Align.END });
    this.currentBox.add(this.currentLeft); this.currentBox.add(this.currentRight); this.window.add_actor(this.currentBox);

    this.metricGrid = new St.Table({ style_class: 'qweather-metrics' }); this.metricGrid.width = w;
    let cellW = Math.floor((w - gap * 2) / 3); this.metricGrid.style = 'spacing-columns: ' + gap + 'px; spacing-rows: ' + gap + 'px;';
    for (let i = 0; i < QWX_METRIC_COLUMNS * QWX_METRIC_ROWS; i++) { let c = this._createMetricCell(cellW); this.metricCells.push(c); this.metricGrid.add(c.box, { row: Math.floor(i / 3), col: i % 3 }); }
    this.window.add_actor(this.metricGrid);

    this.hourlySection = new St.BoxLayout({ vertical: true }); this.hourlySection.width = w;
    this.hourlyTitle = this._boundedLabel(this._ui('Hourly forecast'), w, 'qweather-sec', 'left'); this.hourlySection.add(this.hourlyTitle);
    this.hourlyBox = new St.BoxLayout({ vertical: false, style_class: 'qweather-hourly' }); this.hourlyBox.width = w; this.hourlyBox.style = 'spacing: ' + gap + 'px;';
    let slotW = Math.floor((w - gap * 5) / 6);
    for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
      let box = new St.BoxLayout({ vertical: true, style_class: 'qweather-hour' }); box.width = slotW; box.height = this._scale(72);
      let time = this._boundedLabel('', slotW - this._scale(4), 'qweather-hour-h', 'center'); let icon = this._iconHolder(slotW - this._scale(4), this._scale(26), 'qweather-hour-icon'); let temp = this._boundedLabel('', slotW - this._scale(4), 'qweather-hour-t', 'center');
      box.add(time, { x_fill: false, x_align: St.Align.MIDDLE }); box.add(icon, { x_fill: false, x_align: St.Align.MIDDLE }); box.add(temp, { x_fill: false, x_align: St.Align.MIDDLE });
      let tooltip = new Tooltips.Tooltip(icon); this.hourlySlots.push({ box: box, time: time, icon: icon, temp: temp, tooltip: tooltip }); this.hourlyBox.add(box);
    }
    this.hourlySection.add(this.hourlyBox); if (this.display__hourly) this.window.add_actor(this.hourlySection);

    this.dailySection = new St.BoxLayout({ vertical: true, style_class: 'qweather-daily' }); this.dailySection.width = w;
    this.dailyTitle = this._boundedLabel(UIV2.dayCountTitle(this.lang || 'auto', GLib.get_language_names(), this.no), w, 'qweather-sec', 'left'); this.dailySection.add(this.dailyTitle);
    for (let f = 0; f < this.no; f++) {
      let row = new St.BoxLayout({ vertical: false, style_class: 'qweather-day' }); row.width = w; row.height = this._scale(42);
      let dayBlock = new St.BoxLayout({ vertical: true }); dayBlock.width = this._scale(70);
      let dayLabel = this._boundedLabel('', this._scale(70), 'qweather-day-name', 'left'); let dateLabel = this._boundedLabel('', this._scale(70), 'qweather-day-date', 'left'); dayBlock.add(dayLabel); dayBlock.add(dateLabel);
      let icon = this._iconHolder(this._scale(34), this._scale(30), 'qweather-day-icon'); let temps = this._boundedLabel('', w - this._scale(112), 'qweather-day-temps', 'right');
      row.add(dayBlock); row.add(icon, { x_fill: false, x_align: St.Align.MIDDLE }); row.add(temps, { x_fill: false, x_align: St.Align.END });
      let tooltip = new Tooltips.Tooltip(icon); this.dailyRows.push({ box: row, dayLabel: dayLabel, dateLabel: dateLabel, dayDate: dateLabel, icon: icon, temps: temps, tooltip: tooltip }); this.dailySection.add(row);
    }
    this.window.add_actor(this.dailySection);

    this.sourceBox = new St.BoxLayout({ vertical: false, style_class: 'qweather-source' }); this.sourceBox.width = w;
    this.banner = new St.Button({ label: this._ui('Data source') + ': QWeather', style_class: 'qweather-source-button' }); this.banner.width = w;
    this.bannerpost = new St.Button({ label: ' ' }); this.bannerpost.hide(); this.sourceBox.add(this.banner); this.window.add_actor(this.sourceBox);
    this.bannertooltip = new Tooltips.Tooltip(this.banner); this.cityname = this._boundedLabel('', 1, '', 'left'); this.citytooltip = new Tooltips.Tooltip(this.cityname);
    this.setContent(this.window);
    this.refreshsig = this.refreshbutton.connect('clicked', Lang.bind(this, this._refreshweathers));
    this.bannersig = this.banner.connect('clicked', Lang.bind(this, function () { this.launcher.spawnv(['xdg-open', QWX_WEBSITE]); }));
  },

  displayCurrent: function () {
    if (!this.service || !this.service.data) return;
    let cc = this.service.data.cc || {}; let days = this.service.data.days || []; let today = days[0] || {};
    this.currenttemp.text = this._placeholder(this._formatTemperature(cc.temperature, false) + (cc.temperature === '' ? '' : '°'));
    this.weathertext.text = this._placeholder(cc.weathertext);
    let hi = this._formatTemperature(today.maximum_temperature, false), lo = this._formatTemperature(today.minimum_temperature, false);
    this.hilo.text = (hi !== '' || lo !== '') ? (this._ui('Today') + '  ' + (hi !== '' ? hi + '°' : QWX_PLACEHOLDER) + ' · ' + (lo !== '' ? lo + '°' : QWX_PLACEHOLDER)) : QWX_PLACEHOLDER;
    this.feels.text = this._ui('Feels like') + ' ' + this._placeholder(this._formatTemperature(cc.feelslike, false) + (cc.feelslike === '' ? '' : '°'));
    this._setIcon(this.cwicon, cc.icon, this._scale(QWX_CURRENT_ICON));
    let specs = this._metricSpecs();
    for (let i = 0; i < this.metricCells.length; i++) { let s = specs[i]; this.metricCells[i].key.text = s ? s[0] : ''; this.metricCells[i].value.text = s ? this._placeholder(s[1]) : ''; if (s) this.metricCells[i].box.show(); else this.metricCells[i].box.hide(); }
    this.displayWarning();
  },

  displayHourly: function () {
    if (!this.display__hourly || !this.hourlySlots.length) return;
    let hours = this.service && this.service.data ? (this.service.data.hours || []) : [];
    for (let h = 0; h < QWX_HOURLY_COUNT; h++) {
      let slot = this.hourlySlots[h], hour = hours[h] || null;
      slot.time.text = hour ? UIV2.hourText(this.lang || 'auto', GLib.get_language_names(), hour.time, h === 0) : QWX_PLACEHOLDER;
      slot.temp.text = hour ? this._placeholder(this._formatTemperature(hour.temperature, false) + (hour.temperature === '' ? '' : '°')) : QWX_PLACEHOLDER;
      this._setIcon(slot.icon, hour ? hour.icon : '', this._scale(QWX_HOURLY_ICON));
      slot.tooltip.set_text(hour ? ((hour.weathertext || this._ui('No data')) + '\n' + this._ui('Feels like') + ': ' + this._placeholder(this._formatTemperature(hour.feelslike, true)) + '\n' + this._ui('Wind') + ': ' + this._placeholder(this._formatWind(hour))) : this._ui('No data'));
    }
  },

  _forecastDayDate: function (day) { if (!day || !day.date) return ''; let s = String(day.date); return s.length >= 10 ? s.substring(5, 10) : s; },
  displayForecast: function () {
    let days = this.service && this.service.data ? (this.service.data.days || []) : [];
    for (let f = 0; f < this.dailyRows.length; f++) {
      let row = this.dailyRows[f], day = days[f];
      if (!day) { row.dayLabel.text = f === 0 ? this._ui('Today') : QWX_PLACEHOLDER; row.dateLabel.text = ''; row.temps.text = QWX_PLACEHOLDER; this._setIcon(row.icon, '', this._scale(QWX_DAILY_ICON)); continue; }
      row.dayLabel.text = f === 0 ? this._ui('Today') : (f === 1 ? this._ui('Tomorrow') : UIV2.weekdayText(this.lang || 'auto', GLib.get_language_names(), day.day));
      row.dateLabel.text = this._forecastDayDate(day);
      let hi = this._formatTemperature(day.maximum_temperature, false), lo = this._formatTemperature(day.minimum_temperature, false); row.temps.text = this._placeholder((hi !== '' ? hi + '°' : QWX_PLACEHOLDER) + ' / ' + (lo !== '' ? lo + '°' : QWX_PLACEHOLDER));
      this._setIcon(row.icon, day.icon, this._scale(QWX_DAILY_ICON));
      let tip = day.weathertext || this._ui('No data'); if (day.textNight && day.textNight !== day.weathertext) tip += ' / ' + day.textNight; let details = this._forecastDetailText(day); if (details) tip += '\n' + details; row.tooltip.set_text(tip);
    }
    this.displayCurrent();
  },

  _forecastDetailText: function (day) {
    let parts = []; if (this.display__forecast__wind_direction && day.wind_direction) parts.push(day.wind_direction); if (this.display__forecast__wind_speed) { let w = this._formatWindValue(day.wind_speed, day.wind_scale, true); if (w) parts.push(w); }
    if (this.display__forecast__uv && day.uv !== '') parts.push(this._ui('UV index') + ' ' + Math.round(day.uv)); if (this.display__forecast__precip && day.precip !== '') parts.push(this._formatPrecip(day.precip)); return parts.join(' · ');
  },

  displayWarning: function () {
    if (!this.alertBox) return; let errors = this.service && this.service.data ? (this.service.data.errors || {}) : {}; let err = errors.meta || errors.cc || errors.forecast || (this.display__hourly ? errors.hourly : false) || (this.display__warning ? errors.warning : false);
    if (err) { this.alertTitle.text = '⚠ ' + this._ui('Update failed'); this.alertBody.text = String(err); this.alertBox.set_style_class_name('qweather-alert qweather-alert-error'); this.alertBox.show(); return; }
    let warnings = this.service && this.service.data ? (this.service.data.warnings || []) : [];
    if (this.display__warning && warnings.length) { let w = warnings[0] || {}; this.alertTitle.text = '⚠ ' + (w.title || this._ui('Weather alert')); this.alertBody.text = w.text || ''; this.alertBox.set_style_class_name('qweather-alert qweather-alert-warning'); this.alertBox.show(); return; }
    this.alertTitle.text = this._ui('No active alerts'); this.alertBody.text = ''; this.alertBox.hide();
  },

  displayMeta: function () {
    if (!this.service || !this.service.data) return;
    let loc = this.manuallocation ? String(this.manuallocation) : (this.service.data.city || '');
    let tip = loc || this._ui('No data'); if (this.service.data.region && this.display__meta__region) tip += ', ' + this.service.data.region; if (this.service.data.country && this.display__meta__country) tip += ', ' + this.service.data.country;
    if (this.citytooltip) this.citytooltip.set_text(tip); this.banner.label = this._ui('Data source') + ': QWeather';
  },

  _setLastUpdated: function () { this.currentTime = new Date(); this.lastupdated = this.currentTime.toLocaleFormat('%H:%M'); if (this.bannerupdated) this.bannerupdated.label = this._ui('Updated') + ' ' + this.lastupdated; },
  _refreshweathers: function () { if (this._removed || !this.service) return; this._setLastUpdated(); this.service.refreshData(this); this._doLoop(); },
  _doLoop: function () { if (this._timeoutId) Mainloop.source_remove(this._timeoutId); this._timeoutId = Mainloop.timeout_add_seconds(this.refreshSec, Lang.bind(this, this._refreshweathers)); },
  changeRefresh: function () { if (!this._removed) { this._setDerivedValues(); this._doLoop(); } },
  changeService: function () { if (!this._removed) this.initForecast(); },
  redrawRefetch: function () { if (!this._removed) { this.redraw(); this._refreshweathers(); } },
  structureChange: function () { if (this._removed) return; if (this._structureTimerId) Mainloop.source_remove(this._structureTimerId); this._structureTimerId = Mainloop.timeout_add(120, Lang.bind(this, function () { this._structureTimerId = null; this.redraw(); return false; })); },
  displayOptsChange: function () { if (!this._removed) { this.redraw(); this._refreshweathers(); } },
  iconStyleChange: function () { if (!this._removed) { this._initIcons(); this.displayCurrent(); this.displayHourly(); this.displayForecast(); } },
  onUnitChange: function () { if (!this._removed) { this.displayCurrent(); this.displayHourly(); this.displayForecast(); } },
  redraw: function () { if (this._removed) return; this._setDerivedValues(); this._createWindow(); this.updateStyle(); this.displayCurrent(); this.displayHourly(); this.displayForecast(); this.displayWarning(); this.displayMeta(); },

  updateStyle: function () {
    if (!this.window) return; this.window.width = this._rootWidth();
    if (this.overrideTheme) {
      let bg = (this.bgcolor || 'rgb(18,26,46)').replace(')', ',' + this.transparency + ')').replace('rgb', 'rgba');
      let s = 'padding:' + this._scale(QWX_ROOT_PAD_TOP) + 'px ' + this._scale(QWX_ROOT_PAD_X) + 'px ' + this._scale(12) + 'px;background-color:' + bg + ';color:' + (this.textcolor || '#eef3ff') + ';border-radius:' + (this.cornerradius || 14) + 'px;';
      if (this.border) s += 'border:' + (this.borderwidth || 1) + 'px solid ' + (this.bordercolor || 'rgba(255,255,255,0.14)') + ';'; this.window.style = s;
    }
  },
  setGravity: function () { if (!this._removed && this.actor) this.actor.move_anchor_point_from_gravity(this.experimental_enabled ? this.gravity : 0); },

  _formatTemperature: function (temp, units) { if (temp === '' || temp === null || typeof temp === 'undefined') return ''; let c = Number(temp), v = this.tunits === 'F' ? Math.round(c * 1.8 + 32) : Math.round(c); return units ? v + '°' + (this.tunits === 'F' ? 'F' : 'C') : String(v); },
  _formatHumidity: function (v) { return (v === '' || v === null || typeof v === 'undefined') ? '' : Math.round(Number(v)) + '%'; },
  _formatWindValue: function (wind, scale, units) { if (this.windscale) return scale === '' || scale === null || typeof scale === 'undefined' ? '' : String(scale); return this._formatWindspeed(wind, units); },
  _formatWind: function (o) { if (!o) return ''; let d = o.wind_direction || '', v = this._formatWindValue(o.wind_speed, o.wind_scale, true); return d && v ? d + ' ' + v : (d || v); },
  _formatWindspeed: function (wind, units) { if (wind === '' || wind === null || typeof wind === 'undefined') return ''; let conv = { mph: 0.621, knots: 0.54, kph: 1, mps: 0.278 }, names = { mph: 'mph', knots: 'kn', kph: 'km/h', mps: 'm/s' }; let v = (Number(wind) * (conv[this.wunits] || 1)).toFixed(1).replace(/\.0$/, ''); return units ? v + ' ' + (names[this.wunits] || 'km/h') : v; },
  _formatPressure: function (p, units) { if (p === '' || p === null || typeof p === 'undefined') return ''; let conv = { mb: 1, in: 0.02953, mm: 0.75, kpa: 0.1 }, names = { mb: 'hPa', in: 'in', mm: 'mm', kpa: 'kPa' }, prec = { mb: 0, in: 2, mm: 0, kpa: 1 }; let key = this.punits || 'mb', v = (Number(p) * (conv[key] || 1)).toFixed(prec[key] || 0); return units ? v + ' ' + (names[key] || 'hPa') : v; },
  _formatVisibility: function (v, units) { if (v === '' || v === null || typeof v === 'undefined') return ''; let out = Number(v); if (this.wunits === 'mph') out *= 0.621; let s = out.toFixed(out < 4 ? 1 : 0); return units ? s + (this.wunits === 'mph' ? ' mi' : ' km') : s; },
  _formatPrecip: function (v) { return (v === '' || v === null || typeof v === 'undefined') ? '' : Number(v).toFixed(1).replace(/\.0$/, '') + ' mm'; },

  on_desklet_removed: function () { if (this._timeoutId) Mainloop.source_remove(this._timeoutId); if (this._structureTimerId) Mainloop.source_remove(this._structureTimerId); if (this._globalSettingsSignalId) global.settings.disconnect(this._globalSettingsSignalId); this._removed = true; }
};

function main(metadata, desklet_id) { return new MyDesklet(metadata, desklet_id); }
