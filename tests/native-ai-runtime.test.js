const { test } = require('node:test');
const assert = require('node:assert');

const { resolveWhisperModelForLanguage, WHISPER_MODELS } = require('../src/utils/native-ai-runtime');

test('для русского .en-модель заменяется мультиязычной', () => {
    assert.strictEqual(resolveWhisperModelForLanguage('tiny.en', 'ru'), 'tiny');
    assert.strictEqual(resolveWhisperModelForLanguage('base.en', 'ru'), 'base');
    assert.strictEqual(resolveWhisperModelForLanguage('small.en', 'ru'), 'small');
});

test('для английского .en-модель остаётся как есть', () => {
    assert.strictEqual(resolveWhisperModelForLanguage('base.en', 'en'), 'base.en');
    assert.strictEqual(resolveWhisperModelForLanguage('base.en', 'en-US'), 'base.en');
});

test('мультиязычную модель не трогаем ни при каком языке', () => {
    assert.strictEqual(resolveWhisperModelForLanguage('base', 'ru'), 'base');
    assert.strictEqual(resolveWhisperModelForLanguage('medium', 'en'), 'medium');
});

test('пустой язык и auto считаются английскими — подмены нет', () => {
    assert.strictEqual(resolveWhisperModelForLanguage('tiny.en', ''), 'tiny.en');
    assert.strictEqual(resolveWhisperModelForLanguage('tiny.en', 'auto'), 'tiny.en');
    assert.strictEqual(resolveWhisperModelForLanguage('tiny.en', undefined), 'tiny.en');
});

test('неизвестная модель возвращается без изменений', () => {
    assert.strictEqual(resolveWhisperModelForLanguage('nonexistent', 'ru'), 'nonexistent');
});

test('у каждой .en-модели есть мультиязычная пара', () => {
    for (const [name, model] of Object.entries(WHISPER_MODELS)) {
        if (!model.englishOnly) continue;
        const pair = name.replace(/\.en$/, '');
        assert.ok(WHISPER_MODELS[pair], `нет мультиязычной пары для ${name}`);
        assert.strictEqual(WHISPER_MODELS[pair].englishOnly, false);
    }
});

test('каждая модель описана полностью', () => {
    for (const [name, model] of Object.entries(WHISPER_MODELS)) {
        assert.ok(model.filename, `${name}: нет filename`);
        assert.match(model.sha256, /^[0-9a-f]{64}$/, `${name}: sha256 не похож на sha256`);
        assert.ok(model.url.endsWith(model.filename), `${name}: url не соответствует filename`);
        assert.strictEqual(typeof model.englishOnly, 'boolean', `${name}: нет englishOnly`);
    }
});
