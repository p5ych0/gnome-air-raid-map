// SPDX-License-Identifier: MIT
// GJS Cairo surfaces have no pixel access, so write a PNG and read it back.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import {parseColor} from '../../core/canvas.js';

// Reads the surface once and returns (x, y) -> [r, g, b]. Use it to sample many pixels.
export function pixelReader(surface) {
    const dir = GLib.dir_make_tmp('airmap-px-XXXXXX');
    const path = `${dir}/surface.png`;
    try {
        surface.writeToPNG(path);
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file(path);
        const pixels = pixbuf.get_pixels();
        const stride = pixbuf.get_rowstride(), channels = pixbuf.get_n_channels();
        return (x, y) => {
            const i = y * stride + x * channels;
            return [pixels[i], pixels[i + 1], pixels[i + 2]];
        };
    } finally {
        try { Gio.File.new_for_path(path).delete(null); } catch (e) { /* already gone */ }
        try { Gio.File.new_for_path(dir).delete(null); } catch (e) { /* already gone */ }
    }
}

export function pixelAt(surface, x, y) {
    return pixelReader(surface)(x, y);
}

export function assertColorNear(actual, hex, tolerance = 3) {
    const [r, g, b] = parseColor(hex).map(v => Math.round(v * 255));
    const want = [r, g, b];
    if (!actual.every((v, i) => Math.abs(v - want[i]) <= tolerance))
        throw new Error(`expected color near ${hex} (${want}), got ${actual}`);
}
