// Модели для разбора экрана в Gemini-режиме. Google выводит старые версии из оборота (2.5 на новых
// ключах уже 404), а самая новая на бесплатном тарифе часто отвечает 503 «high demand», пока
// предыдущие работают, — поэтому идём по цепочке, а не падаем на первой.
const SCREEN_MODEL = 'gemini-3.8-flash';
const SCREEN_MODEL_LITE = 'gemini-3.5-flash-lite';
const SCREEN_MODEL_FALLBACKS = [SCREEN_MODEL, 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', SCREEN_MODEL_LITE];

const LIVE_MODEL = 'gemini-3.8-live';
// Значения по умолчанию прошлых версий: их заменяем на текущее, своё значение пользователя не трогаем
const RETIRED_LIVE_DEFAULTS = ['gemini-3.1-flash-live-preview'];

function modelsToTry(preferred) {
    return [preferred, ...SCREEN_MODEL_FALLBACKS.filter(model => model !== preferred)];
}

function errorStatus(error) {
    return error?.status ?? error?.code ?? error?.response?.status;
}

// 503 (перегрузка), 500, 429 (квота модели) и 404 (модель снята) — повод спросить следующую модель
function isRetryableModelError(error) {
    const status = errorStatus(error);
    if ([404, 429, 500, 503].includes(status)) return true;
    return /unavailable|overloaded|high demand|internal error|resource_exhausted|exceeded your current quota|not found/i.test(
        String(error?.message || '')
    );
}

module.exports = { SCREEN_MODEL, SCREEN_MODEL_LITE, SCREEN_MODEL_FALLBACKS, LIVE_MODEL, RETIRED_LIVE_DEFAULTS, modelsToTry, isRetryableModelError };
