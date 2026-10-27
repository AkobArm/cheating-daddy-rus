const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeHexColor } = require('../src/utils/colors');

test('hex-цвет приводится к #rrggbb в нижнем регистре', () => {
    assert.strictEqual(normalizeHexColor('#FFAA00'), '#ffaa00');
    assert.strictEqual(normalizeHexColor(' #fa0 '), '#ffaa00');
});

test('всё, что не hex-цвет, — null (цвет из темы)', () => {
    for (const value of [null, undefined, '', 'red', '#ffff', '#gggggg', 'ffaa00', 42]) {
        assert.strictEqual(normalizeHexColor(value), null, String(value));
    }
});
