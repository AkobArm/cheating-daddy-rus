const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

// '#rrggbb' в нижнем регистре ('#rgb' разворачивается) или null, если это не hex-цвет.
// null в настройке responseTextColor значит «цвет текста из темы».
function normalizeHexColor(value) {
    if (typeof value !== 'string') return null;
    const match = HEX_COLOR_RE.exec(value.trim());
    if (!match) return null;

    let hex = match[1].toLowerCase();
    if (hex.length === 3) {
        hex = hex
            .split('')
            .map(ch => ch + ch)
            .join('');
    }
    return `#${hex}`;
}

module.exports = { normalizeHexColor };
