const { test } = require('node:test');
const assert = require('node:assert');

const { getSystemPrompt } = require('../src/utils/prompts');

test('правила пользователя перебивают длину из профиля и стоят после инструкций профиля', () => {
    const prompt = getSystemPrompt('interview', 'Отвечай развёрнуто', false);
    const priority = prompt.indexOf('**PRIORITY:**');
    assert.ok(priority > 0, 'нет блока приоритета');
    assert.ok(priority > prompt.indexOf('**OUTPUT INSTRUCTIONS:**'), 'приоритет должен идти последним');
});

test('без пользовательского контекста блока приоритета нет', () => {
    assert.ok(!getSystemPrompt('interview', '', false).includes('**PRIORITY:**'));
    assert.ok(!getSystemPrompt('interview', '   ', false).includes('**PRIORITY:**'));
});
