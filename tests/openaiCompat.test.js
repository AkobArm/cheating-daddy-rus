const { test } = require('node:test');
const assert = require('node:assert');

const compat = require('../src/utils/openaiCompat');

test('URL эндпоинтов собираются из базового, лишний хвост и слэши убираются', () => {
    assert.strictEqual(compat.chatCompletionsUrl('https://api.groq.com/openai/v1/'), 'https://api.groq.com/openai/v1/chat/completions');
    assert.strictEqual(compat.chatCompletionsUrl('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/chat/completions');
    assert.strictEqual(compat.modelsUrl('http://localhost:1234/v1/chat/completions'), 'http://localhost:1234/v1/models');
});

test('текстовый запрос уходит строкой, с картинкой — частями image_url', () => {
    assert.strictEqual(compat.toChatContent([{ type: 'input_text', text: 'Вопрос' }]), 'Вопрос');
    assert.deepStrictEqual(
        compat.toChatContent([
            { type: 'input_text', text: 'Что на экране?' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA' },
        ]),
        [
            { type: 'text', text: 'Что на экране?' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } },
        ]
    );
});

test('тело запроса: system-промпт, история и вопрос; без Groq-специфики для других провайдеров', () => {
    const body = JSON.parse(
        compat.buildChatBody({
            model: 'qwen/qwen3.8-27b',
            instructions: 'SYS',
            content: [{ type: 'input_text', text: 'Q2' }],
            history: [
                { role: 'user', text: 'Q1' },
                { role: 'assistant', text: 'A1' },
            ],
            baseUrl: 'http://localhost:1234/v1',
        })
    );
    assert.deepStrictEqual(body.messages, [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
    ]);
    assert.strictEqual(body.stream, true);
    assert.strictEqual(body.max_completion_tokens, undefined);
    assert.strictEqual(body.reasoning_effort, undefined);
});

test('для Groq — лимит токенов против 413 и отключение thinking у qwen3', () => {
    const body = JSON.parse(
        compat.buildChatBody({
            model: 'qwen/qwen3.8-27b',
            instructions: 'SYS',
            content: [{ type: 'input_text', text: 'Q' }],
            baseUrl: 'https://api.groq.com/openai/v1',
            disableThinking: true,
        })
    );
    assert.strictEqual(body.max_completion_tokens, compat.GROQ_MAX_COMPLETION_TOKENS);
    assert.strictEqual(body.reasoning_format, 'hidden');
    assert.strictEqual(body.reasoning_effort, 'none');
});

test('дельта из потока Chat Completions', () => {
    assert.strictEqual(compat.extractDelta({ choices: [{ delta: { content: 'При' } }] }), 'При');
    assert.strictEqual(compat.extractDelta({ choices: [{ delta: { role: 'assistant' } }] }), '');
    assert.strictEqual(compat.extractDelta({}), '');
});

test('рассуждения в <think> не показываются, в том числе недописанные', () => {
    assert.strictEqual(compat.stripThinkingTags('<think>хм</think>Ответ'), 'Ответ');
    assert.strictEqual(compat.stripThinkingTags('<think>ещё думаю'), '');
    assert.strictEqual(compat.stripThinkingTags('<thi'), '');
    assert.strictEqual(compat.stripThinkingTags('Просто ответ'), 'Просто ответ');
});

test('настройки: пресет по умолчанию Groq, ключ Groq из BYOK подхватывается', () => {
    const settings = compat.resolveCompatSettings({ compatModel: ' qwen/qwen3.8-27b ' }, { groqApiKey: 'gsk' }, {});
    assert.deepStrictEqual(settings, {
        label: 'Groq',
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: 'gsk',
        model: 'qwen/qwen3.8-27b',
        disableThinking: true,
    });
});

test('настройки: свой адрес и ключ важнее пресета, ключ Groq не утекает к другому провайдеру', () => {
    const local = compat.resolveCompatSettings({ compatPreset: 'lmstudio', compatModel: 'm' }, { groqApiKey: 'gsk' }, {});
    assert.strictEqual(local.baseUrl, 'http://localhost:1234/v1');
    assert.strictEqual(local.apiKey, '');
    assert.strictEqual(local.label, 'LM Studio');

    const custom = compat.resolveCompatSettings(
        { compatPreset: 'custom', compatBaseUrl: 'https://my.host/v1/', compatModel: 'm' },
        { compatApiKey: 'k', groqApiKey: 'gsk' },
        { disableGroqThinking: false }
    );
    assert.strictEqual(custom.baseUrl, 'https://my.host/v1');
    assert.strictEqual(custom.apiKey, 'k');
    assert.strictEqual(custom.label, 'API');
    assert.strictEqual(custom.disableThinking, false);
});

test('listModels: сортирует и убирает дубли; 401 — подсказка про ключ', async t => {
    const realFetch = global.fetch;
    t.after(() => {
        global.fetch = realFetch;
    });

    global.fetch = async url => {
        assert.strictEqual(url, 'http://localhost:1234/v1/models');
        return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'b' }] }), { status: 200 });
    };
    assert.deepStrictEqual(await compat.listModels({ baseUrl: 'http://localhost:1234/v1' }), ['a', 'b']);

    global.fetch = async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 });
    await assert.rejects(
        compat.listModels({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'x', label: 'Groq' }),
        /Groq returned HTTP 401 \(check the API key\): Invalid API Key/
    );
});
