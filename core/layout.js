// SPDX-License-Identifier: MIT
// Picture size and per-monitor rectangles from the monitor layout.

export const PIXEL_CAP = 16600000;

export function pictureLayout(display, cap = PIXEL_CAP) {
    const logical = display.mode === 'logical';
    const monitors = display.monitors;
    const k = logical ? Math.max(...monitors.map(m => m.scale)) : 1;
    const left = Math.min(...monitors.map(m => m.x));
    const top = Math.min(...monitors.map(m => m.y));
    const right = Math.max(...monitors.map(m => m.x + m.width));
    const bottom = Math.max(...monitors.map(m => m.y + m.height));
    const area = (right - left) * k * (bottom - top) * k;
    const c = area > cap ? Math.sqrt(cap / area) : 1;
    // Each edge is rounded on its own, so neighbors share edges exactly.
    const edge = v => Math.round(v * k * c);
    return {
        width: edge(right - left),
        height: edge(bottom - top),
        monitors: monitors.map(m => ({
            x: edge(m.x - left),
            y: edge(m.y - top),
            width: edge(m.x + m.width - left) - edge(m.x - left),
            height: edge(m.y + m.height - top) - edge(m.y - top),
            scale: (logical ? k : m.scale) * c,
        })),
    };
}

// 'WxH@S[,WxH@S...]': physical sizes, side by side from x = 0, first is primary.
export function parseDisplayOverride(text) {
    let x = 0;
    const monitors = text.split(',').map((part, i) => {
        const match = /^\s*(\d+)x(\d+)@(\d+(?:\.\d+)?)\s*$/.exec(part);
        if (!match)
            throw new Error(`Bad display override: ${part}`);
        const scale = Number(match[3]);
        if (!(scale > 0))
            throw new Error(`Bad display override scale: ${part}`);
        const width = Math.round(Number(match[1]) / scale);
        const height = Math.round(Number(match[2]) / scale);
        const monitor = {x, y: 0, width, height, scale, primary: i === 0};
        x += width;
        return monitor;
    });
    return {mode: 'logical', monitors};
}
