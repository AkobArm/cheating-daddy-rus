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

// ── Кэш каталога ──
// Экран настроек может пересоздаваться, поэтому повторные вызовы не должны бить по сети.

const { listChatGptModels, clearModelsCache, parseReleaseTag, CODEX_CLIENT_VERSION } = require('../src/utils/openaiModels');
const openaiOAuth = require('../src/utils/openaiOAuth');

const GITHUB_RELEASE_URL = 'https://api.github.com/repos/openai/codex/releases/latest';

function stubNetwork(models, { release = 'rust-v0.200.0' } = {}) {
    const catalogUrls = [];
    let releaseCalls = 0;
    const originalFetch = global.fetch;
    const originalAuth = openaiOAuth.ensureValidOpenAIAuth;

    openaiOAuth.ensureValidOpenAIAuth = async () => ({ accessToken: 'test-token', accountId: 'acc' });
    global.fetch = async url => {
        if (url === GITHUB_RELEASE_URL) {
            releaseCalls += 1;
            if (release === null) {
                return { ok: false, status: 403, json: async () => ({}) };
            }
            return { ok: true, status: 200, json: async () => ({ tag_name: release }) };
        }
        catalogUrls.push(url);
        return { ok: true, status: 200, text: async () => JSON.stringify({ models }) };
    };

    return {
        calls: () => catalogUrls.length,
        catalogUrls: () => catalogUrls,
        releaseCalls: () => releaseCalls,
        restore() {
            global.fetch = originalFetch;
            openaiOAuth.ensureValidOpenAIAuth = originalAuth;
        },
    };
}

const CATALOG = [{ slug: 'gpt-5.6-luna', display_name: 'Luna', priority: 1, visibility: 'list' }];

test('повторный вызов берётся из кэша, а не из сети', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG);
    try {
        const first = await listChatGptModels();
        const second = await listChatGptModels();
        assert.strictEqual(net.calls(), 1, 'сеть должна быть задействована один раз');
        assert.deepStrictEqual(first, second);
    } finally {
        net.restore();
        clearModelsCache();
    }
});

test('одновременные вызовы разделяют один запрос', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG);
    try {
        const [a, b, c] = await Promise.all([listChatGptModels(), listChatGptModels(), listChatGptModels()]);
        assert.strictEqual(net.calls(), 1, 'три параллельных вызова — один поход в сеть');
        assert.deepStrictEqual(a, b);
        assert.deepStrictEqual(b, c);
    } finally {
        net.restore();
        clearModelsCache();
    }
});

test('force обходит кэш', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG);
    try {
        await listChatGptModels();
        await listChatGptModels({ force: true });
        assert.strictEqual(net.calls(), 2);
    } finally {
        net.restore();
        clearModelsCache();
    }
});

test('parseReleaseTag вынимает semver из тега rust-v*', () => {
    assert.strictEqual(parseReleaseTag('rust-v0.164.0'), '0.164.0');
    assert.strictEqual(parseReleaseTag('rust-v0.165.0-alpha.1'), null);
    assert.strictEqual(parseReleaseTag('v1.2.3'), null);
    assert.strictEqual(parseReleaseTag(undefined), null);
});

test('каталог запрашивается с версией последнего релиза Codex CLI', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG, { release: 'rust-v0.200.0' });
    try {
        await listChatGptModels();
        assert.ok(net.catalogUrls()[0].endsWith('?client_version=0.200.0'), net.catalogUrls()[0]);
    } finally {
        net.restore();
        clearModelsCache();
    }
});

test('без GitHub каталог запрашивается с запасной версией', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG, { release: null });
    try {
        const models = await listChatGptModels();
        assert.ok(net.catalogUrls()[0].endsWith(`?client_version=${CODEX_CLIENT_VERSION}`), net.catalogUrls()[0]);
        assert.deepStrictEqual(
            models.map(m => m.slug),
            ['gpt-5.6-luna']
        );
    } finally {
        net.restore();
        clearModelsCache();
    }
});

test('кривой тег из GitHub не уходит в каталог', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG, { release: 'nightly' });
    try {
        await listChatGptModels();
        assert.ok(net.catalogUrls()[0].endsWith(`?client_version=${CODEX_CLIENT_VERSION}`), net.catalogUrls()[0]);
    } finally {
        net.restore();
        clearModelsCache();
    }
});

test('версия не перезапрашивается у GitHub при обновлении каталога', async () => {
    clearModelsCache();
    const net = stubNetwork(CATALOG);
    try {
        await listChatGptModels();
        await listChatGptModels({ force: true });
        assert.strictEqual(net.calls(), 2);
        assert.strictEqual(net.releaseCalls(), 1);
    } finally {
        net.restore();
        clearModelsCache();
    }
});

const { pickChatGptModel, migrateSavedChatGptModel, DEFAULT_CHATGPT_MODEL } = require('../src/utils/openaiModels');
const storage = require('../src/storage');

const live = slugs => slugs.map(slug => ({ slug, displayName: slug, description: '' }));

test('запасной список помечен как fallback', () => {
    assert.ok(fallbackModels().every(m => m.fallback === true));
});

test('pickChatGptModel оставляет модель, которая есть в каталоге', () => {
    assert.strictEqual(pickChatGptModel('gpt-6-sol', live(['gpt-6-luna', 'gpt-6-sol'])), 'gpt-6-sol');
});

test('pickChatGptModel переводит исчезнувшую модель на дефолт', () => {
    assert.strictEqual(pickChatGptModel('gpt-5.4-mini', live(['gpt-6-sol', DEFAULT_CHATGPT_MODEL])), DEFAULT_CHATGPT_MODEL);
});

test('pickChatGptModel берёт первую из каталога, если нет и дефолта', () => {
    assert.strictEqual(pickChatGptModel('gpt-5.4-mini', live(['gpt-7-a', 'gpt-7-b'])), 'gpt-7-a');
});

test('pickChatGptModel не трогает выбор по запасному списку', () => {
    assert.strictEqual(pickChatGptModel('gpt-6-sol', fallbackModels()), 'gpt-6-sol');
    assert.strictEqual(pickChatGptModel('gpt-6-sol', []), 'gpt-6-sol');
});

function stubPreferences(chatgptModel) {
    const writes = [];
    const originalGet = storage.getPreferences;
    const originalUpdate = storage.updatePreference;
    storage.getPreferences = () => ({ chatgptModel });
    storage.updatePreference = (key, value) => writes.push([key, value]);
    return {
        writes: () => writes,
        restore() {
            storage.getPreferences = originalGet;
            storage.updatePreference = originalUpdate;
        },
    };
}

test('миграция сохраняет новую модель, если старой нет в каталоге', async () => {
    clearModelsCache();
    const net = stubNetwork([{ slug: DEFAULT_CHATGPT_MODEL, priority: 1, visibility: 'list' }]);
    const prefs = stubPreferences('gpt-5.4-mini');
    try {
        assert.strictEqual(await migrateSavedChatGptModel(), DEFAULT_CHATGPT_MODEL);
        assert.deepStrictEqual(prefs.writes(), [['chatgptModel', DEFAULT_CHATGPT_MODEL]]);
    } finally {
        prefs.restore();
        net.restore();
        clearModelsCache();
    }
});

test('миграция ничего не пишет, если модель на месте', async () => {
    clearModelsCache();
    const net = stubNetwork([{ slug: 'gpt-6-sol', priority: 1, visibility: 'list' }]);
    const prefs = stubPreferences('gpt-6-sol');
    try {
        assert.strictEqual(await migrateSavedChatGptModel(), 'gpt-6-sol');
        assert.deepStrictEqual(prefs.writes(), []);
    } finally {
        prefs.restore();
        net.restore();
        clearModelsCache();
    }
});
