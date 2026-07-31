// ── Итоги беседы ──
//
// Собирает выжимку по завершённой сессии: о чём спрашивали, что отвечали, что стоит
// подтянуть. Работает уже после разговора, когда сессия закрыта, поэтому запрос идёт
// разовым вызовом к ChatGPT по той же подписке — локальные серверы к этому моменту
// обычно уже остановлены.

const MAX_TURNS = 40; // на длинной встрече в запрос уходят последние реплики, а не весь день

const INSTRUCTIONS = `Ты помогаешь разобрать прошедшую беседу (собеседование, звонок, переговоры).
Тебе дают расшифровку: реплики собеседника и ответы, которые подсказывал ассистент.

Сделай разбор на языке беседы, в markdown, по этой структуре:

## О чём говорили
3–6 пунктов с основными темами.

## Вопросы собеседника
Список заданных вопросов, кратко и по делу.

## Что стоит подтянуть
Темы, где ответы были слабыми, поверхностными или их не было. Если таких нет — так и напиши.

## Итог
2–3 предложения: общее впечатление и на чём сфокусироваться дальше.

Не выдумывай того, чего не было в расшифровке. Если беседа слишком короткая для выводов — скажи об этом прямо.`;

function buildTranscript(conversationHistory = []) {
    const turns = conversationHistory.filter(turn => turn?.transcription?.trim() || turn?.ai_response?.trim()).slice(-MAX_TURNS);

    return turns
        .map((turn, index) => {
            const question = (turn.transcription || '').trim();
            const answer = (turn.ai_response || '').trim();
            const parts = [`### Реплика ${index + 1}`];
            if (question) parts.push(`Собеседник: ${question}`);
            if (answer) parts.push(`Подсказанный ответ: ${answer}`);
            return parts.join('\n');
        })
        .join('\n\n');
}

/** Слишком короткую беседу разбирать нечего — честнее сказать сразу, чем звать модель. */
function hasEnoughContent(conversationHistory = []) {
    const meaningful = conversationHistory.filter(turn => (turn?.transcription || '').trim().length > 10);
    return meaningful.length >= 2;
}

/**
 * @param {{conversationHistory: Array, profile?: string}} sessionData
 * @returns {Promise<{success: boolean, summary?: string, error?: string}>}
 */
async function summarizeSession(sessionData) {
    const history = sessionData?.conversationHistory || [];

    if (!hasEnoughContent(history)) {
        return { success: false, error: 'Беседа слишком короткая — нечего разбирать' };
    }

    const transcript = buildTranscript(history);
    const profileLine = sessionData.profile ? `Тип беседы: ${sessionData.profile}.\n\n` : '';

    try {
        // Лениво, чтобы не тянуть цепочку gemini → chatgptai при загрузке модуля
        const { askOneShot } = require('./chatgptai');
        const summary = await askOneShot(INSTRUCTIONS, `${profileLine}Расшифровка беседы:\n\n${transcript}`, {
            reasoningEffort: 'low',
        });

        if (!summary) {
            return { success: false, error: 'Модель вернула пустой ответ' };
        }
        return { success: true, summary };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    summarizeSession,
    buildTranscript,
    hasEnoughContent,
    MAX_TURNS,
};
