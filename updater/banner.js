// SPDX-License-Identifier: MIT
// The failure banner (spec 5.7). The install draws it once. When a run fails, the
// failure unit shows it with picture-options 'centered' on primary-color #0e1722.
// As a script: gjs -m updater/banner.js <out.png>
import Cairo from 'cairo';
import Gio from 'gi://Gio';
import PangoCairo from 'gi://PangoCairo';
import System from 'system';
import {parseColor, parseFont} from '../core/canvas.js';
import {removeFile, renameFile, writePng} from './writer.js';

const WIDTH = 1200, HEIGHT = 360;
// The map background (core/render.js) and the primary-color of the failure unit.
const BACKGROUND = '#0e1722';
const LINES = [
    {text: 'НЕ ОНОВЛЮЄТЬСЯ', font: '700 34px sans-serif', color: '#f2c879'},
    {text: 'Дані на шпалерах можуть бути застарілими', font: '400 20px sans-serif', color: '#e6edf5'},
    {text: 'Дотримуйтеся офіційних сигналів тривоги.', font: '400 20px sans-serif', color: '#a8bdcf'},
];
// The space below the title and below the second line.
const GAPS = [18, 6];

function setColor(cr, css) {
    const [r, g, b, a] = parseColor(css);
    cr.setSourceRGBA(r, g, b, a);
}

// Draws the banner as a PNG at path. It writes path.tmp and renames it over path,
// so GNOME never shows a half-written banner. Throws if it cannot write the file.
export function drawBanner(path) {
    const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, WIDTH, HEIGHT);
    const cr = new Cairo.Context(surface);
    try {
        setColor(cr, BACKGROUND);
        cr.paint();
        const layouts = LINES.map(({text, font}) => {
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(parseFont(font));
            layout.set_text(text, -1);
            return layout;
        });
        // The top of each line, from the top of the first line.
        const extents = layouts.map(layout => layout.get_pixel_extents());
        const tops = [];
        let y = 0;
        extents.forEach(([, logical], i) => {
            tops.push(y);
            y += logical.height + (GAPS[i] ?? 0);
        });
        // Center the visible text, not the line boxes: the capital title has
        // empty space above it, and the last line has descenders below it.
        const last = extents.length - 1;
        const inkTop = tops[0] + extents[0][0].y;
        const inkBottom = tops[last] + extents[last][0].y + extents[last][0].height;
        const offset = Math.round((HEIGHT - inkTop - inkBottom) / 2);
        // Filled glyph outlines, as in core/render.js: grayscale antialiasing.
        layouts.forEach((layout, i) => {
            cr.newPath();
            cr.moveTo(Math.round((WIDTH - extents[i][1].width) / 2), offset + tops[i]);
            PangoCairo.layout_path(cr, layout);
            setColor(cr, LINES[i].color);
            cr.fill();
        });

        const temporary = `${path}.tmp`;
        try {
            writePng(surface, temporary);
            renameFile(temporary, path);
        } catch (e) {
            try {
                removeFile(temporary);
            } catch (removeError) {
                logError(removeError);
            }
            throw e;
        }
    } finally {
        cr.$dispose();
        surface.finish();
    }
}

const isMain = Gio.File.new_for_uri(import.meta.url)
    .equal(Gio.File.new_for_commandline_arg(System.programInvocationName));
if (isMain) {
    if (ARGV.length !== 1) {
        printerr('usage: gjs -m updater/banner.js <out.png>');
        System.exit(2);
    }
    try {
        drawBanner(ARGV[0]);
    } catch (e) {
        printerr(`gnome-air-raid-map: cannot draw the banner: ${e && e.message !== undefined ? e.message : e}`);
        System.exit(1);
    }
}
