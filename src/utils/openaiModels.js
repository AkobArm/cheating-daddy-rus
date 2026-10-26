const openaiOAuth = require('./openaiOAuth');
const storage = require('../storage');

const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';
const ORIGINATOR = 'codex_cli_rs';

const GITHUB_RELEASE_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const CODEX_CLIENT_VERSION = '0.164.0';

const FALLBACK_SLUGS = ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];

const DEFAULT_CHATGPT_MODEL = 'gpt-6-luna';

function fallbackModels() {
    return FALLBACK_SLUGS.map(slug => ({ slug, displayName: slug, description: '', fallback: true }));
}

function pickChatGptModel(saved, models) {
    if (models.length === 0 || models[0].fallback) return saved;
    if (models.some(m => m.slug === saved)) return saved;
    if (models.some(m => m.slug === DEFAULT_CHATGPT_MODEL)) return DEFAULT_CHATGPT_MODEL;
    return models[0].slug;
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

function parseReleaseTag(tag) {
    const match = /^rust-v(\d+\.\d+\.\d+)$/.exec(tag || '');
    return match ? match[1] : null;
}

const VERSION_TTL_MS = 6 * 60 * 60 * 1000;
let versionCache = null;

async function resolveClientVersion() {
    if (versionCache && Date.now() - versionCache.fetchedAt < VERSION_TTL_MS) {
        return versionCache.version;
    }
    try {
        const response = await fetch(GITHUB_RELEASE_URL, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'cheating-daddy' },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const version = parseReleaseTag((await response.json()).tag_name);
        if (!version) {
            throw new Error('неожиданный формат тега');
        }
        versionCache = { version, fetchedAt: Date.now() };
        return version;
    } catch (error) {
        console.warn(`[Models] Версия Codex CLI с GitHub недоступна (${error.message}) — беру ${CODEX_CLIENT_VERSION}`);
        return CODEX_CLIENT_VERSION;
    }
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
    versionCache = null;
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
        const auth = await openaiOAuth.ensureValidOpenAIAuth();
        if (!auth || !auth.accessToken) {
            console.log('[Models] Аккаунт ChatGPT не подключён — запасной список');
            return fallbackModels();
        }

        const url = `${MODELS_URL}?client_version=${await resolveClientVersion()}`;
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

async function migrateSavedChatGptModel() {
    try {
        const saved = storage.getPreferences().chatgptModel;
        const picked = pickChatGptModel(saved, await listChatGptModels());
        if (picked !== saved) {
            console.log(`[Models] ${saved} нет в каталоге — переключаю на ${picked}`);
            storage.updatePreference('chatgptModel', picked);
        }
        return picked;
    } catch (error) {
        console.warn('[Models] Миграция модели не удалась:', error.message);
        return null;
    }
}

module.exports = {
    listChatGptModels,
    migrateSavedChatGptModel,
    pickChatGptModel,
    DEFAULT_CHATGPT_MODEL,
    parseModelsResponse,
    parseReleaseTag,
    fallbackModels,
    clearModelsCache,
    MODELS_URL,
    CODEX_CLIENT_VERSION,
};
