const { test } = require('node:test');
const assert = require('node:assert');

const { fitWithin, jpegQualityFor, pickDisplay, pickSource, captureScreen } = require('../src/utils/screenCapture');

const PRIMARY = { id: 1, size: { width: 1512, height: 982 }, scaleFactor: 2 };
const EXTERNAL = { id: 2, size: { width: 2560, height: 1440 }, scaleFactor: 1 };

function fakeScreen() {
    return {
        getAllDisplays: () => [PRIMARY, EXTERNAL],
        getPrimaryDisplay: () => PRIMARY,
        getDisplayMatching: bounds => (bounds.x >= 1512 ? EXTERNAL : PRIMARY),
    };
}

function fakeImage({ width, height, empty = false }) {
    return {
        isEmpty: () => empty,
        getSize: () => ({ width, height }),
        toJPEG: quality => Buffer.from(`jpeg:${quality}`),
    };
}

function fakeCapturer({ empty = false, sources = null } = {}) {
    const calls = [];
    return {
        calls,
        getSources: async options => {
            calls.push(options);
            if (sources) return sources;
            const image = fakeImage({ ...options.thumbnailSize, empty });
            return [
                { display_id: '1', thumbnail: image },
                { display_id: '2', thumbnail: image },
            ];
        },
    };
}

test('fitWithin уменьшает с сохранением пропорций и не увеличивает', () => {
    assert.deepStrictEqual(fitWithin({ width: 3024, height: 1964 }, 1280), { width: 1280, height: 831 });
    assert.deepStrictEqual(fitWithin({ width: 800, height: 600 }, 1280), { width: 800, height: 600 });
});

test('качество JPEG зависит от ручного режима, неизвестное значение — medium', () => {
    assert.strictEqual(jpegQualityFor('high', true), 85);
    assert.strictEqual(jpegQualityFor('low', false), 50);
    assert.strictEqual(jpegQualityFor('???', true), 60);
});

test('экран из настроек важнее экрана окна', () => {
    const display = pickDisplay(fakeScreen(), { preferredDisplayId: '2', windowBounds: { x: 0, y: 0, width: 10, height: 10 } });
    assert.strictEqual(display.id, 2);
});

test('выбранный экран отключён — берём экран, где окно', () => {
    const display = pickDisplay(fakeScreen(), { preferredDisplayId: '99', windowBounds: { x: 2000, y: 0, width: 10, height: 10 } });
    assert.strictEqual(display.id, 2);
});

test('без настройки и окна — основной экран', () => {
    assert.strictEqual(pickDisplay(fakeScreen()).id, 1);
});

test('источник выбирается по display_id, иначе первый', () => {
    const sources = [{ display_id: '1' }, { display_id: '2' }];
    assert.strictEqual(pickSource(sources, 2), sources[1]);
    assert.strictEqual(pickSource(sources, 7), sources[0]);
    assert.strictEqual(pickSource([], 1), null);
});

test('captureScreen запрашивает кадр в физических пикселях, ужатый до maxWidth', async () => {
    const capturer = fakeCapturer();
    const result = await captureScreen({ desktopCapturer: capturer, screen: fakeScreen(), maxWidth: 1280, quality: 60 });

    assert.deepStrictEqual(capturer.calls[0], { types: ['screen'], thumbnailSize: { width: 1280, height: 831 } });
    assert.strictEqual(result.width, 1280);
    assert.strictEqual(result.displayId, 1);
    assert.strictEqual(Buffer.from(result.data, 'base64').toString(), 'jpeg:60');
});

test('пустой кадр — понятная ошибка про разрешение на запись экрана', async () => {
    await assert.rejects(
        captureScreen({ desktopCapturer: fakeCapturer({ empty: true }), screen: fakeScreen(), maxWidth: 1280, quality: 60 }),
        /Screen Recording/
    );
});

test('нет ни одного экрана — ошибка', async () => {
    await assert.rejects(
        captureScreen({ desktopCapturer: fakeCapturer({ sources: [] }), screen: fakeScreen(), maxWidth: 1280, quality: 60 }),
        /No screen/
    );
});
