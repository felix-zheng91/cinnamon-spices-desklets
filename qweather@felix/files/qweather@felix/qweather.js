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
 * sent to the user's dedicated API Host (console.qweather.com -> 设置),
 * falling back to api.qweather.com when it is not configured.
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

// shared HTTP session, compatible with Soup 2 and Soup 3
var _httpSession;
if (Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2) {
  _httpSession = new Soup.SessionAsync();
  Soup.Session.prototype.add_feature.call(_httpSession, new Soup.ProxyResolverDefault());
} else { // Soup 3
  _httpSession = new Soup.Session();
}

// map of system locales to QWeather lang parameters
const LANG_MAP = {
  'zh_cn': 'zh', 'zh_sg': 'zh', 'zh': 'zh', 'zh_hans': 'zh',
  'zh_tw': 'zh-hant', 'zh_hk': 'zh-hant', 'zh_mo': 'zh-hant', 'zh_hant': 'zh-hant',
  'en': 'en', 'ja': 'ja', 'ko': 'ko', 'de': 'de', 'fr': 'fr', 'es': 'es',
  'it': 'it', 'ru': 'ru', 'pt': 'pt', 'th': 'th', 'hi': 'hi', 'id': 'id',
  'ar': 'ar', 'tr': 'tr', 'vi': 'vi'
};

// error codes -> translated messages
function _errorText(status, body) {
  let detail = '';
  try {
    let j = JSON.parse(body);
    if (j.error && j.error.detail) detail = j.error.detail;
  } catch (e) { }
  switch (status) {
    case 401: return _('Authentication failed. Check your API key');
    case 402: return _('Account balance or quota exhausted');
    case 403: return _('Access denied: check your API Host and subscription');
    case 404: return _('No data for this location');
    case 429: return _('Too many requests: please increase the refresh interval');
  }
  if (detail) return detail;
  if (status === 0 || status === undefined) return _('Network error: check your connection');
  return 'HTTP ' + status;
}

var QWeather = class QWeather {
  constructor(apikey, apihost, location) {
    this.apikey = apikey || '';
    this.apihost = (apihost || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    this.location = (location || '').trim();

    this.minTTL = 600;          // 10 minutes, QWeather data updates every 10-20 min
    this.maxDays = 7;           // upper bound of forecast days to request
    this.lang = 'auto';         // 'auto' or explicit QWeather lang code
    this.wantHourly = true;     // fetch hourly forecast
    this.wantAir = true;        // fetch air quality
    this.wantWarning = true;    // fetch weather warnings

    this.data = new Object();
    this._emptyData();

    // resolved location { id, lat, lon, name, adm1, adm2, country }
    this.loc = null;
    // cache of geo lookups keyed by the location string
    this._geoCache = new Object();
  }

  setApiKey(apikey) { this.apikey = apikey || ''; }
  setApiHost(apihost) {
    apihost = (apihost || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (apihost !== this.apihost) this._geoCache = new Object();
    this.apihost = apihost;
  }
  setLocation(location) { this.location = (location || '').trim(); }
  setLang(lang) { this.lang = lang || 'auto'; }
  setMaxDays(days) { this.maxDays = days; }

  // host used for requests (falls back to the public host)
  get host() {
    return this.apihost.length ? this.apihost : 'api.qweather.com';
  }

  // best QWeather lang code for the current locale
  getLang() {
    if (this.lang && this.lang !== 'auto') return this.lang;
    let langlist = GLib.get_language_names();
    for (let i = 0; i < langlist.length; i++) {
      let l = langlist[i].toLowerCase();
      if (l !== 'c' && typeof LANG_MAP[l] !== 'undefined') return LANG_MAP[l];
    }
    return 'zh';
  }

  _emptyData() {
    this.data.city = '';
    this.data.region = '';
    this.data.country = '';
    this.data.wgs84 = { lat: null, lon: null };

    this.data.status = {
      meta: SERVICE_STATUS_INIT,
      cc: SERVICE_STATUS_INIT,
      forecast: SERVICE_STATUS_INIT,
      hourly: SERVICE_STATUS_INIT,
      air: SERVICE_STATUS_INIT,
      warning: SERVICE_STATUS_INIT,
      lasterror: false
    };

    // current conditions (normalised units: C, km/h, hPa, km, mm, %)
    this.data.cc = {
      temperature: '',
      feelslike: '',
      humidity: '',
      pressure: '',
      weathertext: '',
      icon: '',
      wind_speed: '',
      wind_scale: '',
      wind_direction: '',
      wind_degree: '',
      visibility: '',
      precip: '',
      uv: '',
      has_temp: false
    };

    // air quality
    this.data.air = {
      aqi: '',
      display: '',
      category: '',
      level: '',
      color: '',
      primary: ''
    };

    // hourly forecast
    this.data.hours = [];

    // daily forecast
    this.data.days = [];

    // weather warnings
    this.data.warnings = [];
  }

  // show an error in every section
  _showError(deskletObj, message) {
    this.data.status.meta = SERVICE_STATUS_ERROR;
    this.data.status.cc = SERVICE_STATUS_ERROR;
    this.data.status.forecast = SERVICE_STATUS_ERROR;
    this.data.status.hourly = SERVICE_STATUS_ERROR;
    this.data.status.air = SERVICE_STATUS_ERROR;
    this.data.status.warning = SERVICE_STATUS_ERROR;
    if (message) this.data.status.lasterror = message;
    if (deskletObj) {
      deskletObj.displayCurrent();
      deskletObj.displayForecast();
      deskletObj.displayMeta();
      deskletObj.displayHourly();
      deskletObj.displayWarning();
    }
  }

  // Generic GET with the API key header. callback(ok, text, status)
  _fetch(url, callback) {
    let here = this;
    let message = Soup.Message.new('GET', url);
    message.request_headers.append('X-QW-Api-Key', this.apikey);
    _httpSession.timeout = 15;
    _httpSession.idle_timeout = 15;
    if (Soup.MAJOR_VERSION === undefined || Soup.MAJOR_VERSION === 2) {
      _httpSession.queue_message(message, function (session, message) {
        let status = message.status_code;
        let body = message.response_body.data ? message.response_body.data.toString() : '';
        here._dispatch(url, status, body, callback);
      });
    } else { // Soup 3
      _httpSession.send_and_read_async(message, Soup.MessagePriority.NORMAL, null, function (session, result) {
        let status = message.get_status();
        let body = '';
        try {
          const bytes = _httpSession.send_and_read_finish(result);
          if (bytes) body = ByteArray.toString(bytes.get_data());
        } catch (e) {
          global.logError(e);
        }
        here._dispatch(url, status, body, callback);
      });
    }
  }

  _dispatch(url, status, body, callback) {
    if (status === 200) {
      callback.call(this, true, body, status);
    } else {
      let errmsg = _errorText(status, body);
      global.logWarning(`qweather: Error retrieving ${url}. Status: ${status}: ${errmsg}`);
      callback.call(this, false, body, status);
    }
  }

  // main entry point: resolve the location, then fetch all data.
  // the desklet's display* functions are called from the callbacks.
  refreshData(deskletObj) {
    // keep the previous data while fetching the new one. Blanking the
    // sections at refresh start would make the desklet shrink and grow on
    // every update (and on transient errors); each section is replaced
    // atomically when its own request succeeds.
    if (!this.apikey.length) {
      this._showError(deskletObj, _('No API key configured'));
      return;
    }
    if (!this.location.length) {
      this._showError(deskletObj, _('No location configured'));
      return;
    }
    this._resolveLocation(deskletObj);
  }

  // decide whether the location setting holds coordinates, an ID or a name
  _isCoordinates(loc) {
    return /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(loc);
  }

  // interpret user coordinates: accept "lon,lat" (documented, QWeather
  // convention) as well as the common "lat,lon" order
  _parseCoordinates(loc) {
    let parts = loc.split(',');
    let a = 1 * parts[0].trim();
    let b = 1 * parts[1].trim();
    // |latitude| can never exceed 90: if the second value does, the user
    // most likely entered latitude first
    if (Math.abs(b) > 90) { let t = a; a = b; b = t; }
    if (Math.abs(b) > 90 || Math.abs(a) > 180 || isNaN(a) || isNaN(b)) return null;
    return { lon: a.toFixed(2), lat: b.toFixed(2) };
  }

  _resolveLocation(deskletObj) {
    let here = this;

    if (this._isCoordinates(this.location)) {
      // coordinates are usable directly; fetch the weather right away and
      // do a reverse lookup in the background for the city name
      let coords = this._parseCoordinates(this.location);
      if (!coords) {
        this._showError(deskletObj, _('Invalid coordinates'));
        return;
      }
      this.loc = { lat: coords.lat, lon: coords.lon, name: '', adm1: '', adm2: '', country: '', id: '' };
      this._setMetaFromLoc();
      this._lookup(deskletObj, `${coords.lon},${coords.lat}`, function () {
        // the name lookup only updates the meta display
      }, true);
      this._fetchAll(deskletObj);
      return;
    }

    // city name or LocationID: we must look it up first
    this._lookup(deskletObj, this.location, function (ok) {
      if (ok) {
        here._fetchAll(deskletObj);
      } else {
        // lookup failed - show the error everywhere
        here.data.status.meta = SERVICE_STATUS_ERROR;
        here.data.status.cc = SERVICE_STATUS_ERROR;
        here.data.status.forecast = SERVICE_STATUS_ERROR;
        here.data.status.hourly = SERVICE_STATUS_ERROR;
        here.data.status.air = SERVICE_STATUS_ERROR;
        here.data.status.warning = SERVICE_STATUS_ERROR;
        deskletObj.displayMeta();
        deskletObj.displayCurrent();
        deskletObj.displayForecast();
        deskletObj.displayHourly();
        deskletObj.displayWarning();
      }
    });
  }

  // GeoAPI city lookup (name, LocationID or coordinates)
  // callback(ok) is always called
  _lookup(deskletObj, query, callback, optional) {
    let here = this;
    let cacheKey = query.toLowerCase();

    if (this._geoCache[cacheKey]) {
      this.loc = this._geoCache[cacheKey];
      this._setMetaFromLoc();
      this.data.status.meta = SERVICE_STATUS_OK;
      if (deskletObj) deskletObj.displayMeta();
      callback.call(this, true);
      return;
    }

    let url = `https://${this.host}/geo/v2/city/lookup?location=${encodeURIComponent(query)}&lang=${this.getLang()}&number=1`;
    this._fetch(url, function (ok, text, status) {
      if (!ok) {
        if (!optional) this.data.status.lasterror = _errorText(status, text);
        if (!optional && deskletObj) {
          // give a hint when the public host refuses to serve the GeoAPI
          if (status === 403) this.data.status.lasterror = _('City lookup failed: configure your dedicated API Host in settings');
        }
        callback.call(this, false);
        return;
      }
      try {
        let json = JSON.parse(text);
        if (!json.location || !json.location.length) throw new Error('empty location');
        let l = json.location[0];
        let lat = 1 * l.lat;
        let lon = 1 * l.lon;
        if (isNaN(lat) || isNaN(lon)) throw new Error('invalid coordinates in lookup result');
        let loc = {
          id: l.id || '',
          name: l.name || '',
          adm1: l.adm1 || '',
          adm2: l.adm2 || '',
          country: l.country || '',
          lat: lat.toFixed(2),
          lon: lon.toFixed(2)
        };
        here._geoCache[cacheKey] = loc;
        here.loc = loc;
        here._setMetaFromLoc();
        here.data.status.meta = SERVICE_STATUS_OK;
        if (deskletObj) deskletObj.displayMeta();
        callback.call(here, true);
      } catch (e) {
        global.logError(e);
        if (!optional) {
          this.data.status.lasterror = _('Location not found');
        }
        callback.call(here, false);
      }
    });
  }

  _setMetaFromLoc() {
    if (!this.loc) return;
    this.data.city = this.loc.name;
    this.data.region = this.loc.adm1;
    this.data.country = this.loc.country;
    this.data.wgs84.lat = this.loc.lat;
    this.data.wgs84.lon = this.loc.lon;
  }

  // fetch current weather, daily and hourly forecasts, air quality and warnings
  _fetchAll(deskletObj) {
    if (!this.loc) return;
    let base = `https://${this.host}`;
    let lang = this.getLang();
    let lat = this.loc.lat;
    let lon = this.loc.lon;

    // current conditions
    this._fetch(`${base}/weather/v1/current/${lat}/${lon}?localTime=true&lang=${lang}`, function (ok, text, status) {
      if (ok) {
        try {
          this._parseCurrent(JSON.parse(text));
          this.data.status.cc = SERVICE_STATUS_OK;
        } catch (e) {
          global.logError(e);
          this.data.status.cc = SERVICE_STATUS_ERROR;
          this.data.status.lasterror = _('Error parsing weather data');
        }
      } else {
        this.data.status.cc = SERVICE_STATUS_ERROR;
        this.data.status.lasterror = _errorText(status, text);
      }
      deskletObj.displayCurrent();
    });

    // daily forecast, falling back to 3 days for limited subscriptions
    let days = Math.max(3, Math.min(10, this.maxDays));
    this._fetchDaily(deskletObj, base, lat, lon, lang, days);

    // hourly forecast
    if (this.wantHourly) {
      this._fetch(`${base}/weather/v1/hourly/${lat}/${lon}?hours=24&localTime=true&lang=${lang}`, function (ok, text) {
        if (ok) {
          try {
            this._parseHourly(JSON.parse(text));
            this.data.status.hourly = SERVICE_STATUS_OK;
          } catch (e) {
            global.logError(e);
            this.data.status.hourly = SERVICE_STATUS_ERROR;
          }
        } else {
          this.data.status.hourly = SERVICE_STATUS_ERROR;
        }
        deskletObj.displayHourly();
      });
    }

    // air quality
    if (this.wantAir) {
      this._fetch(`${base}/airquality/v1/current/${lat}/${lon}?lang=${lang}`, function (ok, text) {
        if (ok) {
          try {
            this._parseAir(JSON.parse(text));
            this.data.status.air = SERVICE_STATUS_OK;
          } catch (e) {
            global.logError(e);
            this.data.status.air = SERVICE_STATUS_ERROR;
          }
        } else {
          this.data.status.air = SERVICE_STATUS_ERROR;
        }
        deskletObj.displayCurrent(); // the AQI line is part of the current conditions
      });
    }

    // weather warnings
    if (this.wantWarning) {
      this._fetch(`${base}/weatheralert/v1/current/${lat}/${lon}?localTime=true&lang=${lang}`, function (ok, text) {
        if (ok) {
          try {
            this._parseWarning(JSON.parse(text));
            this.data.status.warning = SERVICE_STATUS_OK;
          } catch (e) {
            global.logError(e);
            this.data.status.warning = SERVICE_STATUS_ERROR;
          }
        } else {
          this.data.status.warning = SERVICE_STATUS_ERROR;
        }
        deskletObj.displayWarning();
      });
    }
  }

  _fetchDaily(deskletObj, base, lat, lon, lang, days) {
    let here = this;
    this._fetch(`${base}/weather/v1/daily/${lat}/${lon}?days=${days}&localTime=true&lang=${lang}`, function (ok, text, status) {
      if (ok) {
        try {
          this._parseDaily(JSON.parse(text));
          this.data.status.forecast = SERVICE_STATUS_OK;
        } catch (e) {
          global.logError(e);
          this.data.status.forecast = SERVICE_STATUS_ERROR;
        }
        deskletObj.displayForecast();
      } else if (days > 3) {
        // free subscriptions may only allow 3 days - try again
        here._fetchDaily(deskletObj, base, lat, lon, lang, 3);
      } else {
        this.data.status.forecast = SERVICE_STATUS_ERROR;
        this.data.status.lasterror = _errorText(status, text);
        deskletObj.displayForecast();
      }
    });
  }

  // ---- response parsing -------------------------------------------------

  _v(obj, key) {
    if (obj && typeof obj[key] !== 'undefined' && obj[key] !== null) return obj[key];
    return null;
  }

  _num(obj, key) {
    let v = this._v(obj, key);
    if (v !== null && typeof v === 'object' && typeof v.value !== 'undefined') v = v.value; // {value, unit} objects
    if (v === null || v === '' || typeof v === 'undefined') return '';
    let n = 1 * v;
    return isNaN(n) ? '' : n;
  }

  // e.g. "2024-05-31T11:00+08:00" -> "11:00";
  // also handles plain "11:00" and "11:00+08:00"
  _timeStr(s) {
    if (!s) return '';
    let m = s.match(/(\d{2}:\d{2})/);
    return m ? m[1] : s;
  }

  // translate a wind compass code (n, nne, ... vrb) for display
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

    let wspeed = this._num(wind, 'speed'); // m/s
    cc.wind_speed = (wspeed === '') ? '' : (wspeed * 3.6).toFixed(1) * 1; // km/h
    cc.wind_scale = this._v(wind, 'scale');
    cc.wind_direction = this.compassPoint(this._v(wdir, 'compass') || '');
    cc.wind_degree = this._v(wdir, 'degree');

    let vis = this._num(j, 'visibility'); // m
    cc.visibility = (vis === '') ? '' : (vis / 1000).toFixed(1) * 1; // km

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
      let dtWDir = this._v(dtWind, 'direction') || {};

      let day = new Object();
      // forecastStartTime is local time at the location
      day.day = this._weekday(this._v(d, 'forecastStartTime'));
      day.date = this._dateStr(this._v(d, 'forecastStartTime'));
      day.maximum_temperature = this._num(d, 'temperatureMax');
      day.minimum_temperature = this._num(d, 'temperatureMin');
      day.weathertext = this._v(dtCond, 'text') || '';
      day.textNight = this._v(ntCond, 'text') || '';
      day.icon = this._v(dtCond, 'code') || '';

      let dws = this._num(dtWind, 'speed'); // m/s
      let nws = this._num(ntWind, 'speed');
      let ws = Math.max(dws === '' ? 0 : dws, nws === '' ? 0 : nws);
      day.wind_speed = (dws === '' && nws === '') ? '' : (ws * 3.6).toFixed(1) * 1;
      day.wind_scale = this._v(dtWind, 'scale');
      day.wind_direction = this.compassPoint(this._v(dtWDir, 'compass') || '');

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

    // prefer the Chinese standard, then QWeather QAQI, then the first one
    let idx = null;
    for (let i = 0; i < indexes.length; i++) {
      let code = ('' + (this._v(indexes[i], 'code') || '')).toLowerCase();
      if (code === 'cn' || code.indexOf('cn-') === 0) { idx = indexes[i]; break; }
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
    for (let i = 0; i < alerts.length; i++) {
      let a = alerts[i];
      let mt = this._v(a, 'messageType') || {};
      // cancel messages supersede previous alerts - skip them for display
      if (this._v(mt, 'code') === 'cancel') continue;

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
      w.end = this._v(a, 'expireTime') || '';
      w.color = (typeof color.red !== 'undefined') ? `rgba(${Math.round(color.red)},${Math.round(color.green)},${Math.round(color.blue)},${(typeof color.alpha === 'undefined') ? 1 : color.alpha})` : '';
      this.data.warnings.push(w);
    }
  }

  // helpers for dates: "2024-05-31T07:00+08:00" -> weekday number (0-6)
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
