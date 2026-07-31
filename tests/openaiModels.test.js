const { test } = require('node:test');
const assert = require('node:assert');

const { parseModelsResponse, fallbackModels } = require('../src/utils/openaiModels');

const catalog = JSON.stringify({
    models: [
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', description: 'глубокая', priority: 3, visibility: 'list', supported_in_api: false },
        { slug: 'gpt-5.6-luna', display_name: 'Luna', description: 'быстрая', priority: 1, visibility: 'list', supported_in_api: true },
        { slug: 'internal', display_name: 'Internal', description: '', priority: 0, visibility: 'hide', supported_in_api: true },
        { slug: 'retired', display_name: 'Retired', description: '', priority: 2, visibility: 'none', supported_in_api: true },
    ],
});

test('оставляет только visibility=list и сортирует по priority', () => {
    const models = parseModelsResponse(catalog);
    assert.deepStrictEqual(
        models.map(m => m.slug),
        ['gpt-5.6-luna', 'gpt-5.5']
    );
    assert.strictEqual(models[0].displayName, 'Luna');
});

test('не фильтрует по supported_in_api', () => {
    // gpt-5.5 помечена supported_in_api=false, но при входе аккаунтом доступна
    assert.ok(parseModelsResponse(catalog).some(m => m.slug === 'gpt-5.5'));
});

test('подставляет slug вместо отсутствующего display_name', () => {
    const body = JSON.stringify({ models: [{ slug: 'gpt-x', priority: 1, visibility: 'list' }] });
    const models = parseModelsResponse(body);
    assert.strictEqual(models[0].displayName, 'gpt-x');
    assert.strictEqual(models[0].description, '');
});

test('на битом JSON бросает', () => {
    assert.throws(() => parseModelsResponse('не json'));
    assert.throws(() => parseModelsResponse('{}'));
});

test('пустой каталог даёт пустой список', () => {
    const body = JSON.stringify({ models: [{ slug: 'h', priority: 1, visibility: 'hide' }] });
    assert.deepStrictEqual(parseModelsResponse(body), []);
});

test('запасной список непустой и без флагманской sol', () => {
    const models = fallbackModels();
    assert.ok(models.length > 0);
    assert.ok(!models.some(m => m.slug === 'gpt-5.6-sol'));
});

test('модели без priority не ломают сортировку', () => {
    const body = JSON.stringify({
        models: [
            { slug: 'b', visibility: 'list' },
            { slug: 'a', priority: -1, visibility: 'list' },
        ],
    });
    assert.deepStrictEqual(
        parseModelsResponse(body).map(m => m.slug),
        ['a', 'b']
    );
});
