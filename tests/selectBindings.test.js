const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Lit применяет .value на <select> раньше, чем вставит опции из .map(): выбирать ещё нечего, браузер
// показывает первую опцию, и если значение потом не меняется, Lit его больше не выставит. Выбор
// таких селектов задаётся свойством .selected на опциях (атрибут ?selected перестаёт работать,
// как только пользователь сам что-то выбрал).

const COMPONENTS = path.join(__dirname, '..', 'src', 'components');

function componentFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return componentFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

function selectsWithMappedOptions() {
    const found = [];
    for (const file of componentFiles(COMPONENTS)) {
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
            if (match[2].includes('.map(')) {
                found.push({ file: path.relative(COMPONENTS, file), tag: match[1], body: match[2] });
            }
        }
    }
    return found;
}

test('селекты с опциями из .map() не задают выбор через .value', () => {
    const selects = selectsWithMappedOptions();
    assert.ok(selects.length >= 5, 'сканер нашёл селекты');

    const offenders = selects.filter(select => /\.value=/.test(select.tag)).map(select => select.file);
    assert.deepStrictEqual(offenders, []);
});

test('опции из .map() выбираются свойством .selected, а не атрибутом', () => {
    const offenders = selectsWithMappedOptions()
        .filter(select => !select.body.includes('.selected=') || select.body.includes('?selected='))
        .map(select => select.file);
    assert.deepStrictEqual(offenders, []);
});
