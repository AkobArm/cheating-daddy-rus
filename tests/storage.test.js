const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Хранилище пишет в домашний каталог — подменяем его до загрузки модуля
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-storage-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const storage = require('../src/storage');

const dir = () => storage.getConfigDir();
const file = name => path.join(dir(), name);
const readJson = name => JSON.parse(fs.readFileSync(file(name), 'utf8'));

function seedOldInstall(config) {
    fs.mkdirSync(path.join(dir(), 'history'), { recursive: true });
    if (config !== undefined) {
        fs.writeFileSync(file('config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    }
    fs.writeFileSync(file('credentials.json'), JSON.stringify({ apiKey: 'gemini-key', groqApiKey: 'groq-key' }));
    fs.writeFileSync(file('preferences.json'), JSON.stringify({ customPrompt: 'мой промпт', chatgptModel: 'gpt-6-luna' }));
    fs.writeFileSync(file('history/123.json'), JSON.stringify({ conversationHistory: [] }));
}

beforeEach(() => {
    fs.rmSync(dir(), { recursive: true, force: true });
});

for (const [name, config] of [
    ['старая версия конфига', { configVersion: 0, groqModel: 'my-model' }],
    ['конфиг без версии', { groqModel: 'my-model' }],
    ['битый config.json', '{"groqModel": "my-mo'],
    ['config.json отсутствует', undefined],
]) {
    test(`${name}: ключи, промпт и история переживают запуск`, () => {
        seedOldInstall(config);

        storage.initializeStorage();

        assert.strictEqual(storage.getApiKey(), 'gemini-key');
        assert.strictEqual(storage.getPreferences().customPrompt, 'мой промпт');
        assert.ok(fs.existsSync(file('history/123.json')));
        assert.strictEqual(readJson('config.json').configVersion, storage.exportAllData().version);
    });
}

test('миграция сохраняет пользовательские поля конфига и добавляет новые по умолчанию', () => {
    seedOldInstall({ configVersion: 0, groqModel: 'my-model' });

    storage.initializeStorage();

    const config = storage.getConfig();
    assert.strictEqual(config.groqModel, 'my-model');
    assert.ok(config.geminiLiveModel, 'новые ключи конфига получают значения по умолчанию');
});

test('чистая установка создаёт все файлы', () => {
    storage.initializeStorage();

    assert.ok(fs.existsSync(file('config.json')));
    assert.ok(fs.existsSync(file('credentials.json')));
    assert.ok(fs.existsSync(file('preferences.json')));
    assert.ok(fs.existsSync(file('history')));
});

test('явная очистка по-прежнему стирает всё', () => {
    seedOldInstall({ configVersion: 1 });

    storage.clearAllData();

    assert.strictEqual(storage.getApiKey(), '');
    assert.strictEqual(storage.getPreferences().customPrompt, '');
    assert.ok(!fs.existsSync(file('history/123.json')));
});

test('запись атомарна: временный файл не остаётся', () => {
    storage.initializeStorage();
    storage.updatePreference('customPrompt', 'новый');

    assert.strictEqual(readJson('preferences.json').customPrompt, 'новый');
    assert.deepStrictEqual(
        fs.readdirSync(dir()).filter(name => name.endsWith('.tmp')),
        []
    );
});

test('снятая Live-модель по умолчанию заменяется на текущую, своя — остаётся', () => {
    storage.initializeStorage();
    const { LIVE_MODEL } = require('../src/utils/geminiModels');

    storage.updateConfig('geminiLiveModel', 'gemini-3.1-flash-live-preview');
    assert.strictEqual(storage.getConfig().geminiLiveModel, LIVE_MODEL);

    storage.updateConfig('geminiLiveModel', 'my-custom-live');
    assert.strictEqual(storage.getConfig().geminiLiveModel, 'my-custom-live');
});
