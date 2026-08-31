const assert = require('assert');
const u = require('../files/qweather@felix/uiv2.js');

assert.equal(u.uiText('zh', [], 'Refresh'), '刷新');
assert.equal(u.uiText('zh', [], 'No active alerts'), '无有效预警');
assert.equal(u.weekdayText('zh', [], 'Tue'), '周二');
assert.equal(u.hourText('zh', [], '15:00', false), '15时');
assert.equal(u.hourText('zh', [], '15:00', true), '现在');
assert.equal(u.dayCountTitle('zh', [], 7), '未来 7 天');
assert.equal(u.uiText('en', [], 'Refresh'), 'Refresh');
assert.deepEqual(u.iconDimensions(20, 2, 1), { width: 40, height: 20 });
assert.deepEqual(u.cleanAttribution('QWeather'), { name: 'QWeather', url: '' });

console.log('uiv2 helpers: 9/9 passed');
