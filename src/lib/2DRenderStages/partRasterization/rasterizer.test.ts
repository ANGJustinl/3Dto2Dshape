import { describe, expect, it } from 'vitest';
import { chooseAtlasWidth } from './rasterizer';

describe('chooseAtlasWidth', () => {
    it('keeps the historical 2048 shelf for ordinary part sizes', () => {
        const parts = Array.from({ length: 400 }, () => ({ width: 60, height: 40 }));
        expect(chooseAtlasWidth(parts, 8192)).toBe(2048);
    });

    it('widens for close-ups so the atlas stays within the device limit', () => {
        const parts = Array.from({ length: 30 }, () => ({ width: 1900, height: 1000 }));
        const width = chooseAtlasWidth(parts, 16384);
        expect(width).toBeGreaterThan(2048);
        // Shelf-pack and confirm the height fits.
        let x = 0;
        let y = 0;
        let row = 0;
        parts.forEach((part) => {
            if (x > 0 && x + part.width > width) {
                x = 0;
                y += row + 1;
                row = 0;
            }
            x += part.width + 1;
            row = Math.max(row, part.height);
        });
        expect(y + row).toBeLessThanOrEqual(16384);
    });

    it('never exceeds the device limit and always fits the widest part', () => {
        expect(chooseAtlasWidth([{ width: 3000, height: 10 }], 8192)).toBe(3000);
        expect(chooseAtlasWidth(Array.from({ length: 999 }, () => ({ width: 4000, height: 4000 })), 8192)).toBe(8192);
    });
});
