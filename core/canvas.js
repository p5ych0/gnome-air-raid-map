// SPDX-License-Identifier: MIT
// A small Canvas2D-style adapter over Cairo and PangoCairo.
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

// "#rrggbb" or "#aarrggbb" (alpha first, as in QML) -> [r, g, b, a], each 0-1.
export function parseColor(css) {
    const m = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(css);
    if (!m) throw new Error(`unsupported color: ${css}`);
    const hex = m[1];
    const byte = i => parseInt(hex.slice(i, i + 2), 16) / 255;
    return hex.length === 8 ? [byte(2), byte(4), byte(6), byte(0)] : [byte(0), byte(2), byte(4), 1];
}

const FAMILIES = {'sans-serif': 'Sans', 'serif': 'Serif', 'monospace': 'Monospace'};

function parseFont(font) {
    const m = /^(?:(\d+)\s+)?(\d+(?:\.\d+)?)px\s+(.+)$/.exec(font.trim());
    if (!m) throw new Error(`unsupported font: ${font}`);
    const desc = new Pango.FontDescription();
    desc.set_family(FAMILIES[m[3]] ?? m[3]);
    desc.set_weight(m[1] ? Number(m[1]) : Pango.Weight.NORMAL);
    desc.set_absolute_size(Number(m[2]) * Pango.SCALE);
    return desc;
}

export class Canvas2D {
    constructor(cr) {
        this._cr = cr;
        this._stack = [];
        this._resetState();
    }

    _resetState() {
        this.fillStyle = '#000000';
        this.strokeStyle = '#000000';
        this.lineWidth = 1;
        this.lineJoin = 'miter';
        this.globalAlpha = 1;
        this.font = '10px sans-serif';
        this.textAlign = 'left';
        this.textBaseline = 'alphabetic';
    }

    _state() {
        const {fillStyle, strokeStyle, lineWidth, lineJoin, globalAlpha, font, textAlign, textBaseline} = this;
        return {fillStyle, strokeStyle, lineWidth, lineJoin, globalAlpha, font, textAlign, textBaseline};
    }

    _source(css) {
        const [r, g, b, a] = parseColor(css);
        this._cr.setSourceRGBA(r, g, b, a * this.globalAlpha);
    }

    _applyStroke() {
        this._cr.setLineWidth(this.lineWidth);
        this._cr.setLineJoin({round: Cairo.LineJoin.ROUND, bevel: Cairo.LineJoin.BEVEL}[this.lineJoin]
            ?? Cairo.LineJoin.MITER);
    }

    save() {
        this._cr.save();
        this._stack.push(this._state());
    }

    restore() {
        const state = this._stack.pop();
        if (!state) return;
        this._cr.restore();
        Object.assign(this, state);
    }

    // Clears the state stack, the transform, the path and the style properties.
    reset() {
        while (this._stack.length) this.restore();
        this._cr.identityMatrix();
        this._cr.newPath();
        this._resetState();
    }

    scale(x, y) { this._cr.scale(x, y); }
    translate(x, y) { this._cr.translate(x, y); }
    rotate(rad) { this._cr.rotate(rad); }

    beginPath() { this._cr.newPath(); }
    moveTo(x, y) { this._cr.moveTo(x, y); }
    lineTo(x, y) { this._cr.lineTo(x, y); }
    closePath() { this._cr.closePath(); }
    arc(x, y, r, a0, a1) { this._cr.arc(x, y, r, a0, a1); }

    fill() {
        this._source(this.fillStyle);
        this._cr.fillPreserve();
    }

    stroke() {
        this._source(this.strokeStyle);
        this._applyStroke();
        this._cr.strokePreserve();
    }

    fillRect(x, y, w, h) {
        this._cr.newPath();
        this._cr.rectangle(x, y, w, h);
        this._source(this.fillStyle);
        this._cr.fill();
    }

    // Makes the rectangle fully transparent, ignoring the current alpha.
    clearRect(x, y, w, h) {
        this._cr.save();
        this._cr.newPath();
        this._cr.rectangle(x, y, w, h);
        this._cr.setOperator(Cairo.Operator.CLEAR);
        this._cr.fill();
        this._cr.restore();
    }

    _layout(text) {
        const layout = PangoCairo.create_layout(this._cr);
        layout.set_font_description(parseFont(this.font));
        layout.set_text(text, -1);
        return layout;
    }

    // Moves to the top-left corner of the layout so the text anchors at (x, y).
    _placeText(layout, x, y) {
        const [width, height] = layout.get_pixel_size();
        let left = x;
        if (this.textAlign === 'center') left -= width / 2;
        else if (this.textAlign === 'right') left -= width;
        let top = y;
        if (this.textBaseline === 'middle') top -= height / 2;
        else if (this.textBaseline === 'alphabetic') top -= layout.get_baseline() / Pango.SCALE;
        this._cr.moveTo(left, top);
    }

    fillText(text, x, y) {
        const layout = this._layout(text);
        this._source(this.fillStyle);
        this._placeText(layout, x, y);
        PangoCairo.show_layout(this._cr, layout);
    }

    strokeText(text, x, y) {
        const layout = this._layout(text);
        this._source(this.strokeStyle);
        this._applyStroke();
        this._cr.newPath();
        this._placeText(layout, x, y);
        PangoCairo.layout_path(this._cr, layout);
        this._cr.stroke();
    }
}
