const { test } = require('node:test');
const assert = require('node:assert');

const { SCREEN_MODEL, SCREEN_MODEL_LITE, modelsToTry, isRetryableModelError } = require('../src/utils/geminiModels');

test('цепочка начинается с выбранной модели и не повторяет её', () => {
    const chain = modelsToTry(SCREEN_MODEL_LITE);
    assert.strictEqual(chain[0], SCREEN_MODEL_LITE);
    assert.strictEqual(chain.filter(model => model === SCREEN_MODEL_LITE).length, 1);
    assert.ok(chain.includes(SCREEN_MODEL));
});

test('в цепочке нет снятых моделей 2.5', () => {
    assert.ok(modelsToTry(SCREEN_MODEL).every(model => !model.startsWith('gemini-2.5')));
});

test('перегрузка, квота и снятая модель — пробуем следующую', () => {
    assert.ok(isRetryableModelError({ status: 503 }));
    assert.ok(isRetryableModelError({ status: 429 }));
    assert.ok(isRetryableModelError({ status: 404 }));
    assert.ok(isRetryableModelError({ message: 'got status: 503 Service Unavailable. This model is currently experiencing high demand' }));
    assert.ok(isRetryableModelError({ message: 'models/gemini-2.5-flash is not found for API version v1beta' }));
});

test('ошибка запроса (плохой ключ, битая картинка) не лечится сменой модели', () => {
    assert.ok(!isRetryableModelError({ status: 400, message: 'API key not valid' }));
    assert.ok(!isRetryableModelError({ status: 403, message: 'Permission denied' }));
});
