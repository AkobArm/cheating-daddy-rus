const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Сквозная проверка режима OpenAI-compatible API: настоящая сессия chatgptai.js против
// поддельного /chat/completions с SSE. Electron подменяем — нужны только события в окно.

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cd-compat-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
const configDir = path.join(home, 'Library', 'Application Support', 'cheating-daddy-config');
fs.mkdirSync(configDir, { recursive: true });
// Распознавание через Groq — чтобы сессия не поднимала whisper-server
fs.writeFileSync(path.join(configDir, 'preferences.json'), JSON.stringify({ chatgptTranscription: 'groq' }));

const events = [];
require.cache[require.resolve('electron')] = {
    exports: {
        BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, data) => events.push([channel, data]) } }] },
        ipcMain: { handle() {}, on() {} },
        safeStorage: null,
        shell: {},
    },
};

const chatgptai = require('../src/utils/chatgptai');

let server;
let baseUrl;
const requests = [];
let reply = () => {};

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => (body += chunk));
        req.on('end', () => {
            requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
            reply(res);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
    chatgptai.closeChatGPTSession();
    server.close();
});

function sse(res, deltas) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const content of deltas) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: content === null ? { role: 'assistant' } : { content } }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
}

test('ответ стримится в окно без <think>, запрос уходит в формате chat completions', async () => {
    const ok = await chatgptai.initializeChatGPTSession('interview', '', 'ru-RU', 'test-model', {
        label: 'Test',
        baseUrl,
        apiKey: 'secret',
        disableThinking: true,
    });
    assert.strictEqual(ok, true);

    reply = res => sse(res, [null, '<think>', 'хм', '</think>', 'При', 'вет']);
    events.length = 0;
    await chatgptai.sendChatGPTText('Расскажи про GIL');

    const request = requests.at(-1);
    assert.strictEqual(request.url, '/v1/chat/completions');
    assert.strictEqual(request.headers.authorization, 'Bearer secret');
    assert.strictEqual(request.body.model, 'test-model');
    assert.strictEqual(request.body.messages[0].role, 'system');
    assert.deepStrictEqual(request.body.messages.at(-1), { role: 'user', content: 'Расскажи про GIL' });
    assert.strictEqual(request.body.max_completion_tokens, undefined, 'Groq-лимит только для Groq');

    const responses = events.filter(([channel]) => channel === 'new-response' || channel === 'update-response');
    assert.deepStrictEqual(responses[0], ['new-response', 'При']);
    assert.deepStrictEqual(responses.at(-1)[1], 'Привет');
    assert.ok(
        responses.every(([, text]) => !text.includes('think')),
        'рассуждения не показываются'
    );
});

test('следующий вопрос несёт историю диалога', async () => {
    reply = res => sse(res, ['Да']);
    await chatgptai.sendChatGPTText('А в 3.13?');

    const messages = requests.at(-1).body.messages;
    assert.deepStrictEqual(
        messages.slice(1).map(m => [m.role, m.content]),
        [
            ['user', 'Расскажи про GIL'],
            ['assistant', 'Привет'],
            ['user', 'А в 3.13?'],
        ]
    );
});

test('скриншот уходит частью image_url', async () => {
    reply = res => sse(res, ['Вижу код']);
    await chatgptai.sendChatGPTImage('QUJD', 'Что на экране?');

    const content = requests.at(-1).body.messages.at(-1).content;
    assert.deepStrictEqual(content, [
        { type: 'text', text: 'Что на экране?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
    ]);
});

test('ошибка провайдера показывается в статусе с подсказкой', async () => {
    reply = res => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API Key' } }));
    };
    events.length = 0;
    await chatgptai.sendChatGPTText('Ещё вопрос');

    const statuses = events.filter(([channel]) => channel === 'update-status').map(([, text]) => text);
    assert.ok(
        statuses.some(text => text === 'Test returned HTTP 401 (check the API key): Invalid API Key'),
        statuses.join(' | ')
    );
});
