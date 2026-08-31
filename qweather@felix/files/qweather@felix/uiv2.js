/*
 * Pure helpers shared by the Cinnamon UI and regression tests.
 */

var UI_ZH = {
  'Feels like': '体感',
  'Humidity': '湿度',
  'Wind': '风速',
  'Pressure': '气压',
  'Air quality': '空气质量',
  'Visibility': '能见度',
  'Precipitation': '降水',
  'UV index': '紫外线',
  'Sunrise': '日出',
  'Sunset': '日落',
  'Hourly forecast': '逐小时预报',
  'Daily forecast': '未来天气',
  'Data source': '数据来源',
  'Updated': '更新于',
  'Today': '今天',
  'Tomorrow': '明天',
  'Now': '现在',
  'Refresh': '刷新',
  'No active alerts': '无有效预警',
  'Update failed': '更新失败',
  'Weather alert': '天气预警',
  'No data': '暂无数据'
};

var UI_ZH_HANT = {
  'Feels like': '體感',
  'Humidity': '濕度',
  'Wind': '風速',
  'Pressure': '氣壓',
  'Air quality': '空氣品質',
  'Visibility': '能見度',
  'Precipitation': '降水',
  'UV index': '紫外線',
  'Sunrise': '日出',
  'Sunset': '日落',
  'Hourly forecast': '逐小時預報',
  'Daily forecast': '未來天氣',
  'Data source': '資料來源',
  'Updated': '更新於',
  'Today': '今天',
  'Tomorrow': '明天',
  'Now': '現在',
  'Refresh': '重新整理',
  'No active alerts': '無有效預警',
  'Update failed': '更新失敗',
  'Weather alert': '天氣預警',
  'No data': '暫無資料'
};

var WEEK_ZH = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日' };
var WEEK_ZH_HANT = { Mon: '週一', Tue: '週二', Wed: '週三', Thu: '週四', Fri: '週五', Sat: '週六', Sun: '週日' };

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

function weekdayText(lang, languageNames, day) {
  let resolved = _normaliseLang(lang, languageNames);
  if (resolved === 'zh-hant' && WEEK_ZH_HANT[day]) return WEEK_ZH_HANT[day];
  if (resolved === 'zh' && WEEK_ZH[day]) return WEEK_ZH[day];
  return day;
}

function hourText(lang, languageNames, value, isNow) {
  if (isNow) return uiText(lang, languageNames, 'Now');
  let text = ('' + (value || '')).trim();
  let match = text.match(/(\d{1,2})(?::\d{2})?/);
  if (!match) return text || '—';
  let hour = parseInt(match[1], 10);
  let resolved = _normaliseLang(lang, languageNames);
  if (resolved === 'zh' || resolved === 'zh-hant') return hour + '时';
  return String(hour).padStart(2, '0') + ':00';
}

function dayCountTitle(lang, languageNames, count) {
  let resolved = _normaliseLang(lang, languageNames);
  if (resolved === 'zh') return '未来 ' + count + ' 天';
  if (resolved === 'zh-hant') return '未來 ' + count + ' 天';
  return 'Next ' + count + ' days';
}

function iconDimensions(height, aspect, adjust) {
  let safeHeight = Number(height);
  let safeAspect = Number(aspect);
  let safeAdjust = Number(adjust);
  if (!isFinite(safeHeight) || safeHeight < 0) safeHeight = 0;
  if (!isFinite(safeAspect) || safeAspect <= 0) safeAspect = 1;
  if (!isFinite(safeAdjust) || safeAdjust <= 0) safeAdjust = 1;
  let actualHeight = safeHeight * safeAdjust;
  return { width: actualHeight * safeAspect, height: actualHeight };
}

function cleanAttribution(item) {
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { uiText: uiText, weekdayText: weekdayText, hourText: hourText, dayCountTitle: dayCountTitle, iconDimensions: iconDimensions, cleanAttribution: cleanAttribution };
}
