// Любой OpenAI-совместимый /chat/completions: Groq, OpenAI, OpenRouter, LM Studio, Ollama, vLLM.
// Голосовой конвейер (whisper, VAD, склейка обрывков) общий с режимом ChatGPT — см. chatgptai.js,
// отсюда только формат запроса и разбор потока.

const PRESETS = [
    { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyUrl: 'https://console.groq.com/keys' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
    { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
    { id: 'lmstudio', label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', keyUrl: '' },
    { id: 'ollama', label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', keyUrl: '' },
    { id: 'custom', label: 'Custom', baseUrl: '', keyUrl: '' },
];

// Groq считает лимит токенов в минуту вместе с зарезервированным max_completion_tokens —
// большой запас давал 413 на бесплатном ключе даже для короткой реплики
const GROQ_MAX_COMPLETION_TOKENS = 2048;

function apiRoot(baseUrl) {
    return String(baseUrl || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/, '');
}

function chatCompletionsUrl(baseUrl) {
    return `${apiRoot(baseUrl)}/chat/completions`;
}

function modelsUrl(baseUrl) {
    return `${apiRoot(baseUrl)}/models`;
}

function isGroq(baseUrl) {
    return /(^|\/\/)api\.groq\.com\b/.test(apiRoot(baseUrl));
}

function stripThinkingTags(text) {
    const trimmedStart = text.trimStart();
    if ('<think>'.startsWith(trimmedStart)) {
        return '';
    }

    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
}

function getGroqReasoningOptions(model, disableThinking) {
    if (model.includes('qwen3')) {
        const options = {
            reasoning_format: 'hidden',
        };

        if (disableThinking) {
            options.reasoning_effort = 'none';
        }

        return options;
    }

    if (model.startsWith('openai/gpt-oss-')) {
        return {
            include_reasoning: false,
        };
    }

    return {};
}

// Части запроса в формате Responses API (input_text / input_image) → формат Chat Completions
function toChatContent(content) {
    const parts = content.map(part =>
        part.type === 'input_image' ? { type: 'image_url', image_url: { url: part.image_url } } : { type: 'text', text: part.text }
    );
    // Чисто текстовый запрос отправляем строкой: часть локальных серверов не понимает массив частей
    return parts.every(part => part.type === 'text') ? parts.map(part => part.text).join('\n') : parts;
}

/**
 * @param {{model: string, instructions: string, content: Array, history?: Array<{role: string, text: string}>,
 *          baseUrl: string, disableThinking?: boolean}} params
 */
function buildChatBody({ model, instructions, content, history = [], baseUrl, disableThinking = true }) {
    const body = {
        model,
        messages: [
            { role: 'system', content: instructions },
            ...history.map(turn => ({ role: turn.role, content: turn.text })),
            { role: 'user', content: toChatContent(content) },
        ],
        stream: true,
    };
    if (isGroq(baseUrl)) {
        Object.assign(body, { max_completion_tokens: GROQ_MAX_COMPLETION_TOKENS }, getGroqReasoningOptions(model, disableThinking));
    }
    return JSON.stringify(body);
}

function extractDelta(event) {
    const delta = event?.choices?.[0]?.delta?.content;
    return typeof delta === 'string' ? delta : '';
}

function authHeaders(apiKey) {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function describeHttpError(response, label) {
    let detail = '';
    try {
        const payload = await response.json();
        detail = payload?.error?.message || payload?.message || '';
    } catch {
        // тело не JSON
    }
    const hint = response.status === 401 ? ' (check the API key)' : '';
    return `${label} returned HTTP ${response.status}${hint}${detail ? `: ${detail}` : ''}`;
}

async function listModels({ baseUrl, apiKey, label = 'API' }) {
    const response = await fetch(modelsUrl(baseUrl), { headers: authHeaders(apiKey), signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
        throw new Error(await describeHttpError(response, label));
    }
    const payload = await response.json();
    const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const ids = entries.map(entry => (typeof entry === 'string' ? entry : entry?.id || entry?.name || '')).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/**
 * Настройки сессии из хранилища. Для Groq без отдельного ключа берём ключ Groq из режима BYOK —
 * он там уже лежит у большинства. Отключение thinking — общая настройка Groq (disableGroqThinking).
 */
function resolveCompatSettings(prefs = {}, credentials = {}, config = {}) {
    const preset = PRESETS.find(p => p.id === prefs.compatPreset) || PRESETS[0];
    const baseUrl = apiRoot(prefs.compatBaseUrl || preset.baseUrl);
    const apiKey = credentials.compatApiKey || (isGroq(baseUrl) ? credentials.groqApiKey || '' : '');
    return {
        label: preset.id === 'custom' ? 'API' : preset.label.replace(/ \(local\)$/, ''),
        baseUrl,
        apiKey,
        model: String(prefs.compatModel || '').trim(),
        disableThinking: config.disableGroqThinking !== false,
    };
}

function requestChatCompletion({ baseUrl, apiKey, body }) {
    return fetch(chatCompletionsUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(apiKey) },
        body,
    });
}

module.exports = {
    PRESETS,
    GROQ_MAX_COMPLETION_TOKENS,
    chatCompletionsUrl,
    modelsUrl,
    isGroq,
    stripThinkingTags,
    getGroqReasoningOptions,
    toChatContent,
    buildChatBody,
    extractDelta,
    describeHttpError,
    listModels,
    resolveCompatSettings,
    requestChatCompletion,
};
