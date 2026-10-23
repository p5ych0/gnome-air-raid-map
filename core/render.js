// SPDX-License-Identifier: MIT
// The alert map of AlertMap.qml, drawn with Cairo and Pango: one full map per monitor.
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import {Canvas2D, parseColor, parseFont} from './canvas.js';
import {marker} from './symbols.js';

const BACKGROUND = '#0e1722';
const MUTED = '#a8bdcf';
const MARGIN = 64;
const LIST_SPACING = 5;
const LIST_GAP = 10;

// Rows of [text, color, underline] pieces. All text is plain; nothing is parsed as markup.
const LEGEND = [['● ', '#cf4655'], ['Червоний рівень ', MUTED], ['● ', '#c69235'], ['Жовтий рівень ', MUTED],
    ['● ', '#7590a8'], ['Без активної тривоги', MUTED]];
const SOURCE = [['Дані: ', MUTED], ['neptun.in.ua', '#8fc8ff', true]];
const NOTICE = 'Дотримуйтеся офіційних сигналів тривоги.';

// The onPaint formula of AlertMap.qml, in logical pixels.
export function mapTransform(bounds, width, height) {
    const b = bounds;
    const padding = Math.max(24, Math.min(width, height) * 0.055);
    const scale = Math.min(Math.max(1, width - padding * 2) / (b[2] - b[0]),
                           Math.max(1, height - padding * 2 - 100) / (b[3] - b[1]));
    const ox = (width - scale * (b[2] - b[0])) / 2;
    const oy = 65 + (height - 100 - scale * (b[3] - b[1])) / 2;
    return {scale, ox, oy, bounds};
}

export function toScreen(t, point) {
    return [t.ox + (point[0] - t.bounds[0]) * t.scale, t.oy + (point[1] - t.bounds[1]) * t.scale];
}

// Do not clamp off-map reports to a false position at the edge.
export function visibleThreats(points, t, width, height) {
    return points.filter(threat => {
        const [x, y] = toScreen(t, threat.point);
        return !(x < 0 || x > width || y < 80 || y > height - 60);
    });
}

export function areaListLimit(textAreaHeight) {
    return Math.max(1, Math.floor((textAreaHeight - 120) / 64));
}

// Splits the region-only items into shown and hidden. heights are the item heights, at most
// areaListLimit of them. The shown items, and the overflow line if an item is hidden, must
// fit in `available` pixels.
export function areaListPlan(heights, total, available, overflowHeight) {
    let used = 0, shown = 0;
    while (shown < heights.length) {
        const end = used + heights[shown];
        const overflow = shown + 1 < total ? LIST_SPACING + overflowHeight : 0;
        if (end + overflow > available) break;
        used = end + LIST_SPACING;
        ++shown;
    }
    return {shown, more: total - shown};
}

export function areaItemText(entry) {
    return entry.region + ' · ' + entry.label
        + (entry.count > 0 ? ' ×' + entry.count : '')
        + (entry.advisory ? '\nСпостереження' : '');
}

function setColor(cr, css) {
    const [r, g, b, a] = parseColor(css);
    cr.setSourceRGBA(r, g, b, a);
}

function plainLayout(cr, text, size, weight = 400) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(parseFont(`${weight} ${size}px sans-serif`));
    layout.set_text(text, -1);
    return layout;
}

// Fills the glyph outlines with the top-left corner at (x, y), over an optional outline.
// Filled outlines keep the antialiasing grayscale, as in Canvas2D.fillText.
function show(cr, layout, x, y, color, outline = null) {
    cr.newPath();
    cr.moveTo(x, y);
    PangoCairo.layout_path(cr, layout);
    if (outline) {
        setColor(cr, outline);
        cr.setLineWidth(2);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.strokePreserve();
    }
    setColor(cr, color);
    cr.fill();
}

// Lays out a row of [text, color, underline] pieces; returns the pieces and the row size.
function rowLayout(cr, pieces, size) {
    const parts = pieces.map(([text, color, underline]) => {
        const layout = plainLayout(cr, text, size);
        if (underline) {
            const attrs = new Pango.AttrList();
            attrs.insert(Pango.attr_underline_new(Pango.Underline.SINGLE));
            layout.set_attributes(attrs);
        }
        const [w, h] = layout.get_size();
        return {layout, color, width: w / Pango.SCALE, height: h / Pango.SCALE};
    });
    return {parts, width: parts.reduce((sum, p) => sum + p.width, 0), height: Math.max(...parts.map(p => p.height))};
}

function showRow(cr, row, x, y) {
    for (const part of row.parts) {
        show(cr, part.layout, x, y, part.color);
        x += part.width;
    }
}

function roundedRect(cr, x, y, w, h, r) {
    cr.newPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
    cr.closePath();
}

// The monitor rectangle inset by the margin. All text stays inside it (spec 6.1).
function textArea(w, h) {
    return {left: MARGIN, top: MARGIN, right: w - MARGIN, bottom: h - MARGIN,
            width: w - 2 * MARGIN, height: h - 2 * MARGIN};
}

function drawMap(ctx, geometry, view, w, h) {
    const oblasts = geometry.oblasts, raions = geometry.raions;
    const t = mapTransform(oblasts.bounds, w, h);

    function path(region) {
        ctx.beginPath();
        for (const polygon of region.polygons) {
            for (const ring of polygon) {
                for (let i = 0; i < ring.length; ++i) {
                    const [x, y] = toScreen(t, ring[i]);
                    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.closePath();
            }
        }
    }

    for (const region of oblasts.regions) {
        path(region); ctx.fillStyle = '#223448'; ctx.fill('evenodd');
    }
    ctx.globalAlpha = view.alertsStale ? 0.4 : 1;
    if (view.alerts && raions) {
        // Red is painted last so overlapping yellow alerts cannot hide it.
        for (const level of ['yellow', 'red']) {
            ctx.fillStyle = level === 'red' ? '#cf4655' : '#c69235';
            for (const kind of ['oblasts', 'raions']) {
                for (const region of geometry[kind].regions) {
                    if (view.alerts[kind]['@' + region.key] === level) {
                        path(region); ctx.fill('evenodd');
                    }
                }
            }
        }
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 0.5;
    ctx.strokeStyle = '#456078';
    if (raions) {
        for (const region of raions.regions) { path(region); ctx.stroke(); }
    }
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#9ab1c6';
    for (const region of oblasts.regions) { path(region); ctx.stroke(); }
    ctx.beginPath();

    ctx.font = `600 ${Math.max(9, Math.min(17, w / 100))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    for (const region of oblasts.regions) {
        if (region.key === 'м. київ' || region.key === 'севастополь') continue;
        const [x, y] = toScreen(t, region.center);
        ctx.strokeStyle = '#172431';
        ctx.strokeText(region.label, x, y);
        ctx.fillStyle = '#eef4fa';
        ctx.fillText(region.label, x, y);
    }

    if (view.threats && !view.threatsStale) {
        const size = Math.max(12, Math.min(16, w / 90));
        for (const threat of visibleThreats(view.threats.points, t, w, h)) {
            const [x, y] = toScreen(t, threat.point);
            marker(ctx, threat, x, y, size, textArea(w, h));
        }
    }
}

// Region-only reports: a header, rounded items, and an overflow count. Items stop at
// areaListLimit, or earlier where the next one would pass `bottom`.
function drawAreaList(cr, view, area, w, bottom) {
    const areas = view.threats.areas;
    const width = Math.min(280, w * 0.24);
    const x = area.left;
    let y = area.top + 50;

    const header = plainLayout(cr, 'ЛИШЕ ОБЛАСТЬ · БЕЗ ТОЧНОЇ ПОЗИЦІЇ', 10);
    show(cr, header, x, y, MUTED);
    y += header.get_pixel_size()[1] + LIST_SPACING;

    const size = Math.max(10, Math.min(14, w / 95));
    const lineHeight = plainLayout(cr, 'X', size).get_size()[1];
    const labels = areas.slice(0, areaListLimit(area.height)).map(entry => {
        const label = plainLayout(cr, areaItemText(entry), size);
        label.set_width(Math.max(1, width - 12) * Pango.SCALE);
        label.set_wrap(Pango.WrapMode.WORD_CHAR);
        label.set_ellipsize(Pango.EllipsizeMode.END);
        // At most three lines in total, as maximumLineCount: 3 in QML. A negative
        // height would count lines per paragraph, and provider text can hold line breaks.
        label.set_height(Math.round(3.5 * lineHeight));
        return label;
    });
    const heights = labels.map(label => label.get_pixel_size()[1] + 12);
    const overflowHeight = plainLayout(cr, 'Ще повідомлень: 0', 12).get_pixel_size()[1];
    const {shown, more} = areaListPlan(heights, areas.length, bottom - y, overflowHeight);

    for (let i = 0; i < shown; ++i) {
        roundedRect(cr, x, y, width, heights[i], 5);
        setColor(cr, '#de152331');
        cr.fill();
        show(cr, labels[i], x + 6, y + 6, areas[i].advisory ? '#9ad6f7' : '#eef4fa');
        y += heights[i] + LIST_SPACING;
    }

    if (more > 0 && y + overflowHeight <= bottom)
        show(cr, plainLayout(cr, 'Ще повідомлень: ' + more, 12), x, y, MUTED);
}

function drawText(cr, geometry, view, w, h) {
    const area = textArea(w, h);

    const title = plainLayout(cr, 'ПОВІТРЯНІ ТРИВОГИ', Math.max(16, Math.min(26, w / 50)), 600);
    const spacing = new Pango.AttrList();
    spacing.insert(Pango.attr_letter_spacing_new(2 * Pango.SCALE));
    title.set_attributes(spacing);
    show(cr, title, area.left, area.top, '#e6edf5');

    const status = plainLayout(cr, view.statusLines.join('\n'), Math.max(11, Math.min(15, w / 85)));
    status.set_alignment(Pango.Alignment.RIGHT);
    show(cr, status, area.right - status.get_pixel_size()[0], area.top,
        view.alertsStale || view.threatsStale ? '#e5b45b' : MUTED);

    if (geometry === null || view.alertsStale) {
        const message = plainLayout(cr, geometry ? 'Немає актуальних даних тривог\nПовторна спроба автоматично'
            : 'Завантаження мапи…', 22, 700);
        message.set_alignment(Pango.Alignment.CENTER);
        const [mw, mh] = message.get_pixel_size();
        show(cr, message, area.left + (area.width - mw) / 2, area.top + (area.height - mh) / 2,
            '#f2c879', BACKGROUND);
    }

    const small = Math.max(10, Math.min(13, w / 100));
    const legend = rowLayout(cr, LEGEND, small);
    const notice = rowLayout(cr, [[NOTICE, MUTED]], small);
    const source = rowLayout(cr, SOURCE, small);

    // The list stops a small gap above the legend and attribution block.
    if (!view.threatsStale && view.threats && view.threats.areas.length > 0) {
        drawAreaList(cr, view, area, w,
            area.bottom - Math.max(legend.height, notice.height + source.height) - LIST_GAP);
    }

    showRow(cr, legend, area.left, area.bottom - legend.height);
    // Two right-aligned lines: the data source above the official-alerts notice.
    showRow(cr, notice, area.right - notice.width, area.bottom - notice.height);
    showRow(cr, source, area.right - source.width, area.bottom - notice.height - source.height);
}

// Draws one full map with all text. rect is the monitor in picture pixels; rect.scale is
// picture pixels per logical pixel, so the QML constants stay in logical pixels.
export function drawMonitor(cr, rect, geometry, view) {
    cr.save();
    try {
        cr.rectangle(rect.x, rect.y, rect.width, rect.height);
        cr.clip();
        cr.translate(rect.x, rect.y);
        cr.scale(rect.scale, rect.scale);
        const w = rect.width / rect.scale, h = rect.height / rect.scale;
        setColor(cr, BACKGROUND);
        cr.paint();
        if (geometry)
            drawMap(new Canvas2D(cr), geometry, view, w, h);
        drawText(cr, geometry, view, w, h);
    } finally {
        cr.restore();
    }
}

export function renderPicture(layout, geometry, view) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, layout.width, layout.height);
    const cr = new Cairo.Context(surface);
    try {
        setColor(cr, BACKGROUND);
        cr.paint();
        for (const rect of layout.monitors)
            drawMonitor(cr, rect, geometry, view);
    } finally {
        cr.$dispose();
    }
    return surface;
}
