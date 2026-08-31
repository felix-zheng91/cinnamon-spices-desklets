/*
 * Pure helpers shared by the Cinnamon UI and QWeather response handling.
 * Keeping these helpers free of GJS-specific APIs makes the layout rules easy
 * to regression-test outside Cinnamon.
 */

var UI_ZH = {
  'Feels like': '体感',
  'Humidity': '湿度',
  'Wind': '风力',
  'Pressure': '气压',
  'Air quality': '空气质量',
  'Visibility': '能见度',
  'Precipitation': '降水量',
  'UV index': '紫外线指数',
  'Sunrise': '日出',
  'Sunset': '日落',
  'Hourly forecast': '逐小时预报',
  'Daily forecast': '未来天气',
  'Data source': '数据源',
  'Updated': '更新于',
  'Today': '今天',
  'No data': '暂无数据'
};

var UI_ZH_HANT = {
  'Feels like': '體感',
  'Humidity': '濕度',
  'Wind': '風力',
  'Pressure': '氣壓',
  'Air quality': '空氣品質',
  'Visibility': '能見度',
  'Precipitation': '降水量',
  'UV index': '紫外線指數',
  'Sunrise': '日出',
  'Sunset': '日落',
  'Hourly forecast': '逐小時預報',
  'Daily forecast': '未來天氣',
  'Data source': '資料來源',
  'Updated': '更新於',
  'Today': '今天',
  'No data': '暫無資料'
};

function _normaliseLang(lang, languageNames) {
  lang = (lang || 'auto').toLowerCase();
  if (lang !== 'auto') return lang;
  languageNames = languageNames || [];
  for (let i = 0; i < languageNames.length; i++) {
    let name = ('' + languageNames[i]).toLowerCase();
    if (name.indexOf('zh_tw') === 0 || name.indexOf('zh_hk') === 0 || name.indexOf('zh_hant') === 0) return 'zh-hant';
    if (name.indexOf('zh') === 0) return 'zh';
  }
  return 'en';
}

function uiText(lang, languageNames, key) {
  let resolved = _normaliseLang(lang, languageNames);
  if (resolved === 'zh-hant' && Object.prototype.hasOwnProperty.call(UI_ZH_HANT, key)) return UI_ZH_HANT[key];
  if (resolved === 'zh' && Object.prototype.hasOwnProperty.call(UI_ZH, key)) return UI_ZH[key];
  return key;
}

function iconDimensions(height, aspect, adjust) {
  let safeHeight = Number(height);
  let safeAspect = Number(aspect);
  let safeAdjust = Number(adjust);
  if (!isFinite(safeHeight) || safeHeight < 0) safeHeight = 0;
  if (!isFinite(safeAspect) || safeAspect <= 0) safeAspect = 1;
  if (!isFinite(safeAdjust) || safeAdjust <= 0) safeAdjust = 1;
  let actualHeight = safeHeight * safeAdjust;
  return {
    width: actualHeight * safeAspect,
    height: actualHeight
  };
}

function cleanAttribution(item) {
  if (typeof item === 'string') {
    return { name: item, url: '' };
  }
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    uiText: uiText,
    iconDimensions: iconDimensions,
    cleanAttribution: cleanAttribution
  };
}
