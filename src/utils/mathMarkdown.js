// Формулы в ответах модели ($...$, $$...$$, \(...\), \[...\]) до marked заменяются заглушками,
// иначе marked съест обратные слэши и подчёркивания. Потом заглушки рендерит KaTeX.
// Код (```...``` и `...`) не трогаем: там $ — это переменные bash, шаблоны и т.п.

const CODE_SEGMENT = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;
const INLINE_DOLLAR = /(^|[^\\$])\$(?![\s$])([^\n$]*?[^\\\s$])\$(?![$\d])/g;

function replaceMath(text, addPlaceholder) {
    return text
        .replace(/\$\$([\s\S]+?)\$\$/g, (_, source) => addPlaceholder(source, true))
        .replace(/\\\[([\s\S]+?)\\\]/g, (_, source) => addPlaceholder(source, true))
        .replace(/\\\(([\s\S]+?)\\\)/g, (_, source) => addPlaceholder(source, false))
        .replace(INLINE_DOLLAR, (_, prefix, source) => prefix + addPlaceholder(source, false));
}

/**
 * @returns {{markdown: string, expressions: Array<{source: string, displayMode: boolean}>}}
 *   в markdown формулы заменены на <span|div data-math-placeholder="N">, N — индекс в expressions
 */
function extractMath(content) {
    const expressions = [];
    const addPlaceholder = (source, displayMode) => {
        const index = expressions.push({ source: source.trim(), displayMode }) - 1;
        const tag = displayMode ? 'div' : 'span';
        return `<${tag} data-math-placeholder="${index}"></${tag}>`;
    };

    const markdown = String(content)
        .split(CODE_SEGMENT)
        .map((segment, i) => (i % 2 === 1 ? segment : replaceMath(segment, addPlaceholder)))
        .join('');

    return { markdown, expressions };
}

module.exports = { extractMath };
