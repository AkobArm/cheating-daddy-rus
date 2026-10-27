const { test } = require('node:test');
const assert = require('node:assert');

const { extractMath } = require('../src/utils/mathMarkdown');

// Порядок в expressions зависит от вида разделителя, а не от позиции — сравниваем без порядка
const sources = content =>
    extractMath(content)
        .expressions.map(e => [e.source, e.displayMode])
        .sort((a, b) => a[0].localeCompare(b[0]));

test('inline $...$ и \\(...\\)', () => {
    assert.deepStrictEqual(sources('Сложность $O(n \\log n)$ и \\(k^2\\).'), [
        ['k^2', false],
        ['O(n \\log n)', false],
    ]);
});

test('блочные $$...$$ и \\[...\\]', () => {
    assert.deepStrictEqual(sources('$$\\sum_{i=1}^n i$$\n\\[ a^2 + b^2 \\]'), [
        ['\\sum_{i=1}^n i', true],
        ['a^2 + b^2', true],
    ]);
});

test('формула заменяется заглушкой, индекс которой указывает на её исходник', () => {
    const { markdown, expressions } = extractMath('Итого $x_1$ и $$y$$');
    const inline = markdown.match(/<span data-math-placeholder="(\d+)"><\/span>/);
    const block = markdown.match(/<div data-math-placeholder="(\d+)"><\/div>/);
    assert.deepStrictEqual(expressions[inline[1]], { source: 'x_1', displayMode: false });
    assert.deepStrictEqual(expressions[block[1]], { source: 'y', displayMode: true });
    assert.strictEqual(markdown.replace(/<(span|div) data-math-placeholder="\d+"><\/\1>/g, '#'), 'Итого # и #');
});

test('деньги и одиночные доллары — не формулы', () => {
    assert.deepStrictEqual(sources('Стоит $5 или $10, бюджет $100 и $200.'), []);
    assert.deepStrictEqual(sources('Цена 5$ за штуку'), []);
});

test('экранированный доллар — не формула', () => {
    assert.deepStrictEqual(sources('Символ \\$x\\$ остаётся'), []);
});

test('код в обратных кавычках и блоках кода не трогаем', () => {
    const content = 'Переменная `$HOME$` и\n```bash\necho "$A$B"\nprice=$x$\n```\nа тут $x$';
    const { markdown, expressions } = extractMath(content);
    assert.deepStrictEqual(
        expressions.map(e => e.source),
        ['x']
    );
    assert.ok(markdown.includes('`$HOME$`'));
    assert.ok(markdown.includes('price=$x$'));
});

test('недописанный блок кода при стриминге тоже не трогаем', () => {
    const { expressions } = extractMath('Код:\n```python\nprint(f"$a$")');
    assert.deepStrictEqual(expressions, []);
});
