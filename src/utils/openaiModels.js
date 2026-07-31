const { ensureValidOpenAIAuth } = require('./openaiOAuth');

const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const ORIGINATOR = 'codex_cli_rs';

// НЕ КОСМЕТИКА: сервер сверяет это значение с minimal_client_version каждой
// модели и молча не отдаёт те, что новее. Семейству gpt-5.6 нужно >= 0.144.0.
// При появлении новых моделей поднимать до актуального релиза Codex CLI
// (github.com/openai/codex, теги rust-v*).
const CODEX_CLIENT_VERSION = '0.146.0';

// Живой каталог зависит от аккаунта; gpt-5.6-sol на Plus-аккаунте не приезжает,
// поэтому в запасной список её не кладём — иначе предложим невыполнимый выбор.
const FALLBACK_SLUGS = ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

function fallbackModels() {
    return FALLBACK_SLUGS.map(slug => ({ slug, displayName: slug, description: '' }));
}

/**
 * Правила повторяют Codex CLI:
 *  - в пикер идут только visibility === 'list'
 *  - порядок по возрастанию priority
 *  - supported_in_api НЕ фильтруем: это условие только для входа по API-ключу,
 *    а у нас вход аккаунтом
 */
function parseModelsResponse(body) {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed.models)) {
        throw new Error('Ответ каталога не содержит массив models');
    }
    return parsed.models
        .filter(m => m.visibility === 'list')
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
        .map(m => ({
            slug: m.slug,
            displayName: m.display_name || m.slug,
            description: m.description || '',
        }));
}

function buildHeaders(auth) {
    return {
        Authorization: `Bearer ${auth.accessToken}`,
        'chatgpt-account-id': auth.accountId || '',
        originator: ORIGINATOR,
        Accept: 'application/json',
    };
}

// Каталог меняется редко, а экран настроек может перерисоваться несколько раз подряд —
// без кэша это лишние сетевые запросы на каждый ре-рендер.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = null; // { models, fetchedAt }
let inFlight = null; // общий промис, пока запрос ещё летит

function getCachedModels() {
    if (!cache) return null;
    return Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache.models : null;
}

function clearModelsCache() {
    cache = null;
    inFlight = null;
}

/** Никогда не бросает: настройки должны открываться и без сети. */
async function listChatGptModels({ force = false } = {}) {
    if (!force) {
        const cached = getCachedModels();
        if (cached) {
            return cached;
        }
        // Два экземпляра настроек, созданные подряд, должны разделить один запрос
        if (inFlight) {
            return inFlight;
        }
    }

    inFlight = fetchModels();
    try {
        return await inFlight;
    } finally {
        inFlight = null;
    }
}

async function fetchModels() {
    try {
        const auth = await ensureValidOpenAIAuth();
        if (!auth || !auth.accessToken) {
            console.log('[Models] Аккаунт ChatGPT не подключён — запасной список');
            return fallbackModels();
        }

        const url = `${MODELS_URL}?client_version=${CODEX_CLIENT_VERSION}`;
        const response = await fetch(url, { headers: buildHeaders(auth) });
        console.log(`[Models] Каталог ответил: HTTP ${response.status}`);

        if (!response.ok) {
            return fallbackModels();
        }

        const models = parseModelsResponse(await response.text());
        if (models.length === 0) {
            return fallbackModels();
        }

        console.log(`[Models] Каталог: ${models.map(m => m.slug).join(', ')}`);
        cache = { models, fetchedAt: Date.now() };
        return models;
    } catch (error) {
        console.warn('[Models] Каталог недоступен:', error.message);
        return fallbackModels();
    }
}

module.exports = {
    listChatGptModels,
    parseModelsResponse,
    fallbackModels,
    clearModelsCache,
    MODELS_URL,
    CODEX_CLIENT_VERSION,
};
