const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Голосовая реплика с приложенным кадром экрана и ручной разбор экрана оба содержат картинку.
// Различать их по наличию картинки нельзя — иначе обычный диалог уезжает во вкладку Screen.
// Полноценно выполнить chatgptai.js в тестах нельзя (он тянет electron), поэтому
// проверяем сам контракт по исходнику.

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'chatgptai.js'), 'utf8');

test('streamResponses принимает признак разбора экрана', () => {
    assert.match(source, /async function streamResponses\(content, options = \{\}\)/);
    assert.match(source, /isScreenAnalysis = false/);
});

test('ручной скриншот помечается как разбор экрана', () => {
    const call = source.match(/sendToRenderer\('update-status', 'Analyzing image\.\.\.'\);[\s\S]{0,200}/);
    assert.ok(call, 'не найден вызов ручного разбора экрана');
    assert.match(call[0], /streamResponses\(content, \{ isScreenAnalysis: true \}\)/);
});

test('голосовая реплика отправляется без этого признака', () => {
    const fn = source.match(/async function sendToChatGPT\(text\)[\s\S]*?\n\}/);
    assert.ok(fn, 'не найдена отправка голосовой реплики');
    assert.match(fn[0], /await streamResponses\(content\);/, 'реплика не должна помечаться как разбор экрана');
    assert.ok(/latestScreenshot/.test(fn[0]), 'к реплике по-прежнему прикладывается последний кадр');
});

test('в Screen попадает только помеченный разбор экрана', () => {
    assert.match(source, /if \(isScreenAnalysis\) \{[\s\S]{0,400}saveScreenAnalysis\(/);
    assert.match(source, /\} else \{[\s\S]{0,120}saveConversationTurn\(/);
});

test('повторная генерация сохраняет тип исходного запроса', () => {
    assert.match(source, /session\.lastRequestWasScreen = isScreenAnalysis/);
    assert.match(source, /streamResponses\(session\.lastRequest, \{ isScreenAnalysis: session\.lastRequestWasScreen \}\)/);
});

test('повтор при истёкшем токене не теряет признак', () => {
    assert.match(source, /streamResponses\(content, \{ \.\.\.options, retryOn401: false \}\)/);
});
