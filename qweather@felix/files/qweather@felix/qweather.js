/*
 * qweather.js - QWeather (和风天气) API module for the qweather@felix desklet
 *
 * Uses the current QWeather API v1:
 *   /weather/v1/current/{lat}/{lon}      实况天气
 *   /weather/v1/daily/{lat}/{lon}        逐天预报 (days 1-10)
 *   /weather/v1/hourly/{lat}/{lon}       逐小时预报 (hours 1-240)
 *   /airquality/v1/current/{lat}/{lon}   实时空气质量
 *   /weatheralert/v1/current/{lat}/{lon} 实时天气预警
 *   /geo/v2/city/lookup                  城市搜索 / 坐标反查
 *
 * Authentication: API Key in the X-QW-Api-Key request header. Requests are
 * sent to the user's dedicated API Host (console.qweather.com -> 设置).
 *
 * Data units returned by the API (v1, metric):
 *   temperature °C, wind speed m/s, pressure hPa, visibility m,
 *   precipitation mm, humidity [0,1], probability [0,1]
 * This module normalises to: °C, km/h, hPa, km, mm, %.
 *
 * Based on bbcwx@oak-wood.co.uk by Chris Hastie (GPLv3), itself forked
 * from accudesk@logan by loganj. This file: GPLv3.
 */

const ByteArray = imports.byteArray;
const GLib = imports.gi.GLib;
const Gettext = imports.gettext;
const Soup = imports.gi.Soup;

const UUID = 'qweather@felix';

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + '/.local/share/locale');

function _(str) {
  if (str) return Gettext.dgettext(UUID, str);
}

var SERVICE_STATUS_ERROR = 0;
var SERVICE_STATUS_INIT = 1;
var SERVICE_STATUS_OK = 2;

var _httpSession;
if (Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2) {
  _httpSession = new Soup.SessionAsync();
  Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());
} else {
  _httpSession = new Soup.Session();
}

const LANG_MAP = {
  'zh_cn': 'zh', 'zh_sg': 'zh', 'zh': 'zh', 'zh_hans': 'zh',
  'zh_tw': 'zh-hant', 'zh_hk': 'zh-hant', 'zh_mo': 'zh-hant', 'zh_hant': 'zh-hant',
  'en': 'en', 'ja': 'ja', 'ko': 'ko', 'de': 'de', 'fr': 'fr', 'es': 'es',
  'it': 'it', 'ru': 'ru', 'pt': 'pt', 'th': 'th', 'hi': 'hi', 'id': 'id',
  'ar': 'ar', 'tr': 'tr', 'vi': 'vi', 'bn': 'bn', 'ms': 'ms', 'nl': 'nl',
  'el': 'el', 'la': 'la', 'sv': 'sv', 'pl': 'pl', 'cs': 'cs', 'et': 'et',
  'fil': 'fil', 'fi': 'fi', 'he': 'he', 'is': 'is', 'nb': 'nb'
};

function _normaliseApiHost(apihost) {
  return (apihost || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function _validApiHost(apihost) {
  return /^[A-Za-z0-9.-]+(?::\d+)?$/.test(apihost || '');
}

function _jsonErrorInfo(body) {
  let result = { legacyCode: null, detail: '' };
  try {
    let j = JSON.parse(body);
    if (typeof j.code !== 'undefined' && j.code !== null) {
      let code = parseInt(j.code, 10);
      if (!isNaN(code)) result.legacyCode = code;
    }
    if (j.error) {
      result.detail = j.error.detail || j.error.message || j.error.title || '';
      if (result.legacyCode === null && typeof j.error.code !== 'undefined') {
        let code = parseInt(j.error.code, 10);
        if (!isNaN(code)) result.legacyCode = code;
      }
    }
  } catch (e) { }
  return result;
}

function _effectiveStatus(status, body) {
  if (status !== 200) return status;
  let info = _jsonErrorInfo(body);
  if (info.legacyCode !== null && info.legacyCode !== 200) return info.legacyCode;
  return status;
}

function _errorText(status, body) {
  let info = _jsonErrorInfo(body);
  let effective = _effectiveStatus(status, body);
  switch (effective) {
    case 204: return _('No data for this location');
    case 400: return _('Invalid request. Check the location and settings');
    case 401: return _('Authentication failed. Check your API key');
    case 402: return _('Account balance or quota exhausted');
    case 403: return _('Access denied: check your API Host and subscription');
    case 404: return _('No data for this location');
    case 429: return _('Too many requests: please increase the refresh interval');
  }
  if (info.detail) return info.detail;
  if (effective === 0 || effective === undefined) return _('Network error: check your connection');
  return 'HTTP ' + effective;
}

function _cleanAttribution(item) {
  if (typeof item === 'string') return { name: item, url: '' };
  if (!item || typeof item !== 'object') return null;

  let name = '';
  let url = '';
  if (Object.prototype.hasOwnProperty.call(item, 'name') && typeof item.name === 'string') name = item.name;
  else if (Object.prototype.hasOwnProperty.call(item, 'title') && typeof item.title === 'string') name = item.title;
  else if (Object.prototype.hasOwnProperty.call(item, 'service') && typeof item.service === 'string') name = item.service;

  if (Object.prototype.hasOwnProperty.call(item, 'url') && typeof item.url === 'string') url = item.url;
  else if (Object.prototype.hasOwnProperty.call(item, 'link') && typeof item.link === 'string') url = item.link;

  if (!name && !url) return null;
  return { name: name, url: url };
}

var QWeather = class QWeather {
  constructor(apikey, apihost, location) {
    this.apikey = (apikey || '').trim();
    this.apihost = _normaliseApiHost(apihost);
    this.location = (location || '').trim();
    this.minTTL = 600;
    this.maxDays = 7;
    this.lang = 'auto';
    this.wantHourly = true;
    this.wantAir = true;
    this.wantWarning = true;
    this.data = new Object();
    this._emptyData();
    this.loc = null;
    this._geoCache = new Object();
    this._generation = 0;
    this._deskletObj = null;
    this._lastSuccessfulUpdate = null;
  }

  setApiKey(apikey) { this.apikey = (apikey || '').trim(); }
  setApiHost(apihost) {
    apihost = _normaliseApiHost(apihost);
    if (apihost !== this.apihost) this._geoCache = new Object();
    this.apihost = apihost;
  }
  setLocation(location) { this.location = (location || '').trim(); }
  setLang(lang) { this.lang = lang || 'auto'; }
  setMaxDays(days) { this.maxDays = days; }

  get host() { return this.apihost; }

  getLang() {
    if (this.lang && this.lang !== 'auto') return this.lang;
    let langlist = GLib.get_language_names();
    for (let i = 0; i < langlist.length; i++) {
      let l = langlist[i].toLowerCase();
      if (l === 'c') continue;
      if (typeof LANG_MAP[l] !== 'undefined') return LANG_MAP[l];
      let base = l.split(/[_.@-]/)[0];
      if (base !== 'zh' && typeof LANG_MAP[base] !== 'undefined') return LANG_MAP[base];
    }
    return '';
  }

  _langQuery(prefix) {
    let lang = this.getLang();
    if (!lang) return '';
    return (prefix || '&') + 'lang=' + encodeURIComponent(lang);
  }

  _emptyData() {
    this.data.city = '';
    this.data.region = '';
    this.data.country = '';
    this.data.wgs84 = { lat: null, lon: null };
    this.data.status = {
      meta: SERVICE_STATUS_INIT, cc: SERVICE_STATUS_INIT, forecast: SERVICE_STATUS_INIT,
      hourly: SERVICE_STATUS_INIT, air: SERVICE_STATUS_INIT, warning: SERVICE_STATUS_INIT,
      lasterror: false
    };
    this.data.errors = { meta: false, cc: false, forecast: false, hourly: false, air: false, warning: false };
    this.data.attributions = [];
    this.data.cc = {
      temperature: '', feelslike: '', humidity: '', pressure: '', weathertext: '', icon: '',
      wind_speed: '', wind_scale: '', wind_direction: '', wind_degree: '', visibility: '',
      precip: '', uv: '', has_temp: false
    };
    this.data.air = { aqi: '', display: '', category: '', level: '', color: '', primary: '' };
    this.data.hours = [];
    this.data.days = [];
    this.data.warnings = [];
  }

  _markOk(section) {
    if (typeof this.data.status[section] !== 'undefined') this.data.status[section] = SERVICE_STATUS_OK;
    if (this.data.errors && typeof this.data.errors[section] !== 'undefined') this.data.errors[section] = false;
  }

  _markError(section, message) {
    if (typeof this.data.status[section] !== 'undefined') this.data.status[section] = SERVICE_STATUS_ERROR;
    if (this.data.errors && typeof this.data.errors[section] !== 'undefined') this.data.errors[section] = message || false;
    if (message) this.data.status.lasterror = message;
  }

  _displayWithError(deskletObj, section, displayFunc) {
    if (!deskletObj || deskletObj._removed) return;
    let previous = this.data.status.lasterror;
    if (this.data.errors && this.data.errors[section]) this.data.status.lasterror = this.data.errors[section];
    displayFunc.call(deskletObj);
    this.data.status.lasterror = previous;
  }

  _captureAttributions(j) {
    let metadata = this._v(j, 'metadata') || {};
    let attrs = this._v(metadata, 'attributions') || [];
    for (let i = 0; i < attrs.length; i++) {
      let a = _cleanAttribution(attrs[i]);
      if (!a) continue;
      let duplicate = false;
      for (let n = 0; n < this.data.attributions.length; n++) {
        let existing = this.data.attributions[n];
        if (existing.name === a.name && existing.url === a.url) {
          duplicate = true;
          break;
        }
      }
      if (!duplicate) this.data.attributions.push(a);
    }
    this._updateAttributionDisplay();
  }

  _updateAttributionDisplay() {
    let deskletObj = this._deskletObj;
    if (!deskletObj || deskletObj._removed) return;
    let labels = [];
    for (let i = 0; i < this.data.attributions.length; i++) {
      let a = this.data.attributions[i];
      if (!a.name && !a.url) continue;
      labels.push(a.name ? a.name : a.url);
    }
    if (deskletObj.bannerpost) {
      let extras = labels.filter(function (name) { return ('' + name).toLowerCase() !== 'qweather'; });
      deskletObj.bannerpost.label = extras.length ? ' · ' + extras.join(', ') : ' ';
    }
    if (deskletObj.bannertooltip && labels.length) {
      let details = [];
      for (let i = 0; i < this.data.attributions.length; i++) {
        let a = this.data.attributions[i];
        let line = a.name || a.url || '';
        if (a.name && a.url) line += ' — ' + a.url;
        if (line) details.push(line);
      }
      deskletObj.bannertooltip.set_text(_('Data attribution') + ':\n' + details.join('\n'));
    }
  }

  _showError(deskletObj, message) {
    this._markError('meta', message); this._markError('cc', message); this._markError('forecast', message);
    this._markError('hourly', message); this._markError('air', message); this._markError('warning', message);
    if (deskletObj && !deskletObj._removed) {
      this._displayWithError(deskletObj, 'cc', deskletObj.displayCurrent);
      this._displayWithError(deskletObj, 'forecast', deskletObj.displayForecast);
      this._displayWithError(deskletObj, 'meta', deskletObj.displayMeta);
      this._displayWithError(deskletObj, 'hourly', deskletObj.displayHourly);
      this._displayWithError(deskletObj, 'warning', deskletObj.displayWarning);
    }
  }

  _isRequestCurrent(generation) {
    if (generation !== this._generation) return false;
    if (!this._deskletObj) return true;
    if (this._deskletObj._removed) return false;
    if (this._deskletObj.service && this._deskletObj.service !== this) return false;
    return true;
  }

  _restoreLastUpdated(deskletObj) {
    if (!deskletObj || !deskletObj.bannerupdated) return;
    if (this._lastSuccessfulUpdate) {
      let text = this._lastSuccessfulUpdate.toLocaleFormat('%c');
      deskletObj.lastupdated = text;
      deskletObj.bannerupdated.label = text;
    } else {
      deskletObj.lastupdated = '';
      deskletObj.bannerupdated.label = '';
    }
  }

  _markSuccessfulUpdate(deskletObj) {
    this._lastSuccessfulUpdate = new Date();
    if (!deskletObj || !deskletObj.bannerupdated || deskletObj._removed) return;
    let text = this._lastSuccessfulUpdate.toLocaleFormat('%c');
    deskletObj.currentTime = this._lastSuccessfulUpdate;
    deskletObj.lastupdated = text;
    deskletObj.bannerupdated.label = text;
  }

  _fetch(url, callback, generation) {
    let here = this;
    let message;
    try { message = Soup.Message.new('GET', url); }
    catch (e) {
      global.logError(e);
      if (this._isRequestCurrent(generation)) callback.call(this, false, '', 0);
      return;
    }
    if (!message) {
      if (this._isRequestCurrent(generation)) callback.call(this, false, '', 0);
      return;
    }
    message.request_headers.append('X-QW-Api-Key', this.apikey);
    _httpSession.timeout = 15;
    _httpSession.idle_timeout = 15;
    if (Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2) {
      _httpSession.queue_message(message, function (session, message) {
        if (!here._isRequestCurrent(generation)) return;
        let status = message.status_code;
        let body = message.response_body.data ? message.response_body.data.toString() : '';
        here._dispatch(url, status, body, callback, generation);
      });
    } else {
      _httpSession.send_and_read_async(message, Soup.MessagePriority.NORMAL, null, function (session, result) {
        if (!here._isRequestCurrent(generation)) return;
        let status = message.get_status();
        let body = '';
        try {
          const bytes = _httpSession.send_and_read_finish(result);
          if (bytes) body = ByteArray.toString(bytes.get_data());
        } catch (e) {
          global.logError(e);
          status = status || 0;
        }
        here._dispatch(url, status, body, callback, generation);
      });
    }
  }

  _dispatch(url, status, body, callback, generation) {
    if (!this._isRequestCurrent(generation)) return;
    let effective = _effectiveStatus(status, body);
    if (effective === 200) callback.call(this, true, body, effective);
    else {
      let errmsg = _errorText(effective, body);
      global.logWarning(`qweather: Error retrieving ${url}. Status: ${effective}: ${errmsg}`);
      callback.call(this, false, body, effective);
    }
  }

  refreshData(deskletObj) {
    this._deskletObj = deskletObj || null;
    let generation = ++this._generation;
    this.data.attributions = [];
    this._updateAttributionDisplay();
    this._restoreLastUpdated(deskletObj);
    if (!this.apikey.length) { this._showError(deskletObj, _('No API key configured')); return; }
    if (!this.apihost.length) { this._showError(deskletObj, _('No API Host configured')); return; }
    if (!_validApiHost(this.apihost)) { this._showError(deskletObj, _('Invalid API Host')); return; }
    if (!this.location.length) { this._showError(deskletObj, _('No location configured')); return; }
    this._resolveLocation(deskletObj, generation);
  }

  _isCoordinates(loc) { return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(loc); }

  _parseCoordinates(loc) {
    let parts = loc.split(',');
    let a = 1 * parts[0].trim();
    let b = 1 * parts[1].trim();
    if (Math.abs(b) > 90) { let t = a; a = b; b = t; }
    if (Math.abs(b) > 90 || Math.abs(a) > 180 || isNaN(a) || isNaN(b)) return null;
    return { lon: a.toFixed(2), lat: b.toFixed(2) };
  }

  _resolveLocation(deskletObj, generation) {
    let here = this;
    if (!this._isRequestCurrent(generation)) return;
    if (this._isCoordinates(this.location)) {
      let coords = this._parseCoordinates(this.location);
      if (!coords) { this._showError(deskletObj, _('Invalid coordinates')); return; }
      this.loc = { lat: coords.lat, lon: coords.lon, name: '', adm1: '', adm2: '', country: '', id: '' };
      this._setMetaFromLoc();
      this._lookup(deskletObj, `${coords.lon},${coords.lat}`, function () {}, true, generation);
      this._fetchAll(deskletObj, generation);
      return;
    }
    this._lookup(deskletObj, this.location, function (ok) {
      if (!here._isRequestCurrent(generation)) return;
      if (ok) here._fetchAll(deskletObj, generation);
      else {
        let err = here.data.errors.meta || here.data.status.lasterror || _('Location not found');
        here._markError('meta', err); here._markError('cc', err); here._markError('forecast', err);
        here._markError('hourly', err); here._markError('air', err); here._markError('warning', err);
        here._displayWithError(deskletObj, 'meta', deskletObj.displayMeta);
        here._displayWithError(deskletObj, 'cc', deskletObj.displayCurrent);
        here._displayWithError(deskletObj, 'forecast', deskletObj.displayForecast);
        here._displayWithError(deskletObj, 'hourly', deskletObj.displayHourly);
        here._displayWithError(deskletObj, 'warning', deskletObj.displayWarning);
      }
    }, false, generation);
  }

  _lookup(deskletObj, query, callback, optional, generation) {
    let here = this;
    let cacheKey = query.toLowerCase();
    if (this._geoCache[cacheKey]) {
      this.loc = this._geoCache[cacheKey];
      this._setMetaFromLoc();
      this._markOk('meta');
      if (deskletObj) this._displayWithError(deskletObj, 'meta', deskletObj.displayMeta);
      callback.call(this, true);
      return;
    }
    let url = `https://${this.host}/geo/v2/city/lookup?location=${encodeURIComponent(query)}&number=1${this._langQuery('&')}`;
    this._fetch(url, function (ok, text, status) {
      if (!ok) {
        if (!optional) {
          let err = _errorText(status, text);
          if (status === 403) err = _('City lookup failed: check your dedicated API Host and subscription');
          this._markError('meta', err);
        }
        callback.call(this, false);
        return;
      }
      try {
        let json = JSON.parse(text);
        this._captureAttributions(json);
        if (!json.location || !json.location.length) throw new Error('empty location');
        let l = json.location[0];
        let lat = 1 * l.lat;
        let lon = 1 * l.lon;
        if (isNaN(lat) || isNaN(lon)) throw new Error('invalid coordinates in lookup result');
        let loc = { id: l.id || '', name: l.name || '', adm1: l.adm1 || '', adm2: l.adm2 || '', country: l.country || '', lat: lat.toFixed(2), lon: lon.toFixed(2) };
        here._geoCache[cacheKey] = loc;
        here.loc = loc;
        here._setMetaFromLoc();
        here._markOk('meta');
        if (deskletObj) here._displayWithError(deskletObj, 'meta', deskletObj.displayMeta);
        callback.call(here, true);
      } catch (e) {
        global.logError(e);
        if (!optional) here._markError('meta', _('Location not found'));
        callback.call(here, false);
      }
    }, generation);
  }

  _setMetaFromLoc() {
    if (!this.loc) return;
    this.data.city = this.loc.name;
    this.data.region = this.loc.adm1;
    this.data.country = this.loc.country;
    this.data.wgs84.lat = this.loc.lat;
    this.data.wgs84.lon = this.loc.lon;
  }

  _fetchAll(deskletObj, generation) {
    if (!this.loc || !this._isRequestCurrent(generation)) return;
    let base = `https://${this.host}`;
    let langQuery = this._langQuery('&');
    let airLang = this.getLang();
    let airLangQuery = airLang ? '?lang=' + encodeURIComponent(airLang) : '';
    let lat = this.loc.lat;
    let lon = this.loc.lon;

    this._fetch(`${base}/weather/v1/current/${lat}/${lon}?localTime=true${langQuery}`, function (ok, text, status) {
      if (ok) {
        try {
          let json = JSON.parse(text); this._captureAttributions(json); this._parseCurrent(json); this._markOk('cc'); this._markSuccessfulUpdate(deskletObj);
        } catch (e) { global.logError(e); this._markError('cc', _('Error parsing weather data')); }
      } else this._markError('cc', _errorText(status, text));
      this._displayWithError(deskletObj, 'cc', deskletObj.displayCurrent);
    }, generation);

    let days = Math.max(3, Math.min(10, this.maxDays));
    this._fetchDaily(deskletObj, base, lat, lon, langQuery, days, generation);

    if (this.wantHourly) {
      this._fetch(`${base}/weather/v1/hourly/${lat}/${lon}?hours=24&localTime=true${langQuery}`, function (ok, text, status) {
        if (ok) {
          try { let json = JSON.parse(text); this._captureAttributions(json); this._parseHourly(json); this._markOk('hourly'); }
          catch (e) { global.logError(e); this._markError('hourly', _('Error parsing weather data')); }
        } else this._markError('hourly', _errorText(status, text));
        this._displayWithError(deskletObj, 'hourly', deskletObj.displayHourly);
      }, generation);
    }

    if (this.wantAir) {
      this._fetch(`${base}/airquality/v1/current/${lat}/${lon}${airLangQuery}`, function (ok, text, status) {
        if (ok) {
          try { let json = JSON.parse(text); this._captureAttributions(json); this._parseAir(json); this._markOk('air'); }
          catch (e) { global.logError(e); this._markError('air', _('Error parsing weather data')); }
        } else this._markError('air', _errorText(status, text));
        let displayErrorSection = this.data.status.cc === SERVICE_STATUS_ERROR ? 'cc' : 'air';
        this._displayWithError(deskletObj, displayErrorSection, deskletObj.displayCurrent);
      }, generation);
    }

    if (this.wantWarning) {
      this._fetch(`${base}/weatheralert/v1/current/${lat}/${lon}?localTime=true${langQuery}`, function (ok, text, status) {
        if (ok) {
          try { let json = JSON.parse(text); this._captureAttributions(json); this._parseWarning(json); this._markOk('warning'); }
          catch (e) { global.logError(e); this._markError('warning', _('Error parsing weather data')); }
        } else { this._dropExpiredWarnings(); this._markError('warning', _errorText(status, text)); }
        this._displayWithError(deskletObj, 'warning', deskletObj.displayWarning);
      }, generation);
    }
  }

  _fetchDaily(deskletObj, base, lat, lon, langQuery, days, generation) {
    this._fetch(`${base}/weather/v1/daily/${lat}/${lon}?days=${days}&localTime=true${langQuery}`, function (ok, text, status) {
      if (ok) {
        try { let json = JSON.parse(text); this._captureAttributions(json); this._parseDaily(json); this._markOk('forecast'); }
        catch (e) { global.logError(e); this._markError('forecast', _('Error parsing weather data')); }
      } else this._markError('forecast', _errorText(status, text));
      this._displayWithError(deskletObj, 'forecast', deskletObj.displayForecast);
    }, generation);
  }

  _v(obj, key) {
    if (obj && typeof obj[key] !== 'undefined' && obj[key] !== null) return obj[key];
    return null;
  }

  _num(obj, key) {
    let v = this._v(obj, key);
    if (v !== null && typeof v === 'object' && typeof v.value !== 'undefined') v = v.value;
    if (v === null || v === '' || typeof v === 'undefined') return '';
    let n = 1 * v;
    return isNaN(n) ? '' : n;
  }

  _timeStr(s) {
    if (!s) return '';
    let m = s.match(/(\d{2}:\d{2})/);
    return m ? m[1] : s;
  }

  compassPoint(code) {
    let map = {
      'n': _('N'), 'nne': _('NNE'), 'ne': _('NE'), 'ene': _('ENE'),
      'e': _('E'), 'ese': _('ESE'), 'se': _('SE'), 'sse': _('SSE'),
      's': _('S'), 'ssw': _('SSW'), 'sw': _('SW'), 'wsw': _('WSW'),
      'w': _('W'), 'wnw': _('WNW'), 'nw': _('NW'), 'nnw': _('NNW'),
      'vrb': _('Variable'), 'none': ''
    };
    code = ('' + code).toLowerCase();
    return (typeof map[code] !== 'undefined') ? map[code] : '';
  }

  _parseCurrent(j) {
    let cc = this.data.cc;
    let cond = this._v(j, 'condition') || {};
    let wind = this._v(j, 'wind') || {};
    let wdir = this._v(wind, 'direction') || {};
    let precip = this._v(j, 'precipitation') || {};
    cc.temperature = this._num(j, 'temperature');
    cc.feelslike = this._num(j, 'feelsLike');
    cc.has_temp = cc.temperature !== '';
    cc.weathertext = this._v(cond, 'text') || '';
    cc.icon = this._v(cond, 'code') || '';
    let humidity = this._num(j, 'humidity');
    cc.humidity = (humidity === '') ? '' : Math.round(humidity * 100);
    cc.pressure = this._num(j, 'pressure');
    let wspeed = this._num(wind, 'speed');
    cc.wind_speed = (wspeed === '') ? '' : (wspeed * 3.6).toFixed(1) * 1;
    cc.wind_scale = this._v(wind, 'scale');
    cc.wind_direction = this.compassPoint(this._v(wdir, 'compass') || '');
    cc.wind_degree = this._v(wdir, 'degree');
    let vis = this._num(j, 'visibility');
    cc.visibility = (vis === '') ? '' : (vis / 1000).toFixed(1) * 1;
    cc.precip = this._num(precip, 'amount');
    cc.uv = this._num(j, 'uvIndex');
  }

  _parseDaily(j) {
    let days = this._v(j, 'days') || [];
    this.data.days = [];
    for (let i = 0; i < days.length; i++) {
      let d = days[i];
      let daytime = this._v(d, 'daytime') || {};
      let night = this._v(d, 'nighttime') || {};
      let astro = this._v(d, 'astro') || {};
      let dtCond = this._v(daytime, 'condition') || {};
      let ntCond = this._v(night, 'condition') || {};
      let dtWind = this._v(daytime, 'wind') || {};
      let ntWind = this._v(night, 'wind') || {};
      let dtPrecip = this._v(daytime, 'precipitation') || {};
      let day = new Object();
      day.day = this._weekday(this._v(d, 'forecastStartTime'));
      day.date = this._dateStr(this._v(d, 'forecastStartTime'));
      day.maximum_temperature = this._num(d, 'temperatureMax');
      day.minimum_temperature = this._num(d, 'temperatureMin');
      day.weathertext = this._v(dtCond, 'text') || '';
      day.textNight = this._v(ntCond, 'text') || '';
      day.icon = this._v(dtCond, 'code') || '';
      let dws = this._num(dtWind, 'speed');
      let nws = this._num(ntWind, 'speed');
      let chosenWind;
      if (dws === '' && nws === '') chosenWind = null;
      else if (dws === '') chosenWind = ntWind;
      else if (nws === '' || dws >= nws) chosenWind = dtWind;
      else chosenWind = ntWind;
      if (chosenWind) {
        let ws = this._num(chosenWind, 'speed');
        let chosenDir = this._v(chosenWind, 'direction') || {};
        day.wind_speed = (ws === '') ? '' : (ws * 3.6).toFixed(1) * 1;
        day.wind_scale = this._v(chosenWind, 'scale');
        day.wind_direction = this.compassPoint(this._v(chosenDir, 'compass') || '');
      } else {
        day.wind_speed = ''; day.wind_scale = ''; day.wind_direction = '';
      }
      day.uv = this._num(d, 'uvIndexMax');
      day.precip = this._num(dtPrecip, 'amount');
      let prob = this._num(dtPrecip, 'probability');
      day.precip_prob = (prob === '') ? '' : Math.round(prob * 100);
      day.sunrise = this._timeStr(this._v(astro, 'sunrise'));
      day.sunset = this._timeStr(this._v(astro, 'sunset'));
      this.data.days.push(day);
    }
  }

  _parseHourly(j) {
    let hours = this._v(j, 'hours') || [];
    this.data.hours = [];
    for (let i = 0; i < hours.length; i++) {
      let h = hours[i];
      let cond = this._v(h, 'condition') || {};
      let precip = this._v(h, 'precipitation') || {};
      let wind = this._v(h, 'wind') || {};
      let wdir = this._v(wind, 'direction') || {};
      let hour = new Object();
      hour.time = this._timeStr(this._v(h, 'forecastTime'));
      hour.temperature = this._num(h, 'temperature');
      hour.feelslike = this._num(h, 'feelsLike');
      hour.weathertext = this._v(cond, 'text') || '';
      hour.icon = this._v(cond, 'code') || '';
      let prob = this._num(precip, 'probability');
      hour.precip_prob = (prob === '') ? '' : Math.round(prob * 100);
      hour.precip = this._num(precip, 'amount');
      let ws = this._num(wind, 'speed');
      hour.wind_speed = (ws === '') ? '' : (ws * 3.6).toFixed(1) * 1;
      hour.wind_scale = this._v(wind, 'scale');
      hour.wind_direction = this.compassPoint(this._v(wdir, 'compass') || '');
      this.data.hours.push(hour);
    }
  }

  _parseAir(j) {
    let indexes = this._v(j, 'indexes') || [];
    if (!indexes.length) throw new Error('no air quality indexes');
    let idx = null;
    for (let i = 0; i < indexes.length; i++) {
      let code = ('' + (this._v(indexes[i], 'code') || '')).toLowerCase();
      if (code !== 'qaqi') { idx = indexes[i]; break; }
    }
    if (!idx) {
      for (let i = 0; i < indexes.length; i++) {
        if (('' + (this._v(indexes[i], 'code') || '')).toLowerCase() === 'qaqi') { idx = indexes[i]; break; }
      }
    }
    if (!idx) idx = indexes[0];
    let color = this._v(idx, 'color') || {};
    let primary = this._v(idx, 'primaryPollutant') || {};
    this.data.air = {
      aqi: this._v(idx, 'aqi'),
      display: this._v(idx, 'aqiDisplay') || ('' + this._v(idx, 'aqi')),
      category: this._v(idx, 'category') || '',
      level: this._v(idx, 'level') || '',
      color: (typeof color.red !== 'undefined') ? `rgba(${Math.round(color.red)},${Math.round(color.green)},${Math.round(color.blue)},${(typeof color.alpha === 'undefined') ? 1 : color.alpha})` : '',
      primary: this._v(primary, 'name') || ''
    };
  }

  _parseWarning(j) {
    let alerts = this._v(j, 'alerts') || [];
    this.data.warnings = [];
    let now = Date.now();
    for (let i = 0; i < alerts.length; i++) {
      let a = alerts[i];
      let mt = this._v(a, 'messageType') || {};
      if (this._v(mt, 'code') === 'cancel') continue;
      let expire = this._v(a, 'expireTime') || '';
      let expireMs = expire ? Date.parse(expire) : NaN;
      if (!isNaN(expireMs) && expireMs <= now) continue;
      let et = this._v(a, 'eventType') || {};
      let color = this._v(a, 'color') || {};
      let w = new Object();
      w.title = this._v(a, 'headline') || this._v(et, 'name') || _('Weather warning');
      w.type = this._v(et, 'name') || '';
      w.level = this._v(color, 'code') || '';
      w.icon = this._v(a, 'icon') || '';
      w.sender = this._v(a, 'senderName') || '';
      w.text = this._v(a, 'description') || '';
      let instruction = this._v(a, 'instruction') || '';
      if (instruction) w.text += '\n\n' + instruction;
      w.start = this._v(a, 'effectiveTime') || this._v(a, 'onsetTime') || '';
      w.end = expire;
      w.color = (typeof color.red !== 'undefined') ? `rgba(${Math.round(color.red)},${Math.round(color.green)},${Math.round(color.blue)},${(typeof color.alpha === 'undefined') ? 1 : color.alpha})` : '';
      this.data.warnings.push(w);
    }
  }

  _dropExpiredWarnings() {
    if (!this.data.warnings || !this.data.warnings.length) return;
    let now = Date.now();
    this.data.warnings = this.data.warnings.filter(function (w) {
      if (!w.end) return true;
      let expireMs = Date.parse(w.end);
      return isNaN(expireMs) || expireMs > now;
    });
  }

  _weekday(dateStr) {
    if (!dateStr || dateStr.length < 10) return '';
    let d = new Date(dateStr.substring(0, 4), dateStr.substring(5, 7) - 1, dateStr.substring(8, 10));
    let days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[d.getDay()];
  }

  _dateStr(dateStr) {
    if (!dateStr || dateStr.length < 10) return '';
    return dateStr.substring(0, 10);
  }
};
