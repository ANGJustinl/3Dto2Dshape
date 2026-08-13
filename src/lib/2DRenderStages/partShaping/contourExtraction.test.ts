import { describe, expect, it } from 'vitest';
import { extractLoopsFromMask } from './contourExtraction';

const maskFromRows = (rows: string[]) => {
    const width = rows[0]?.length ?? 0;
    const occupied = new Uint8Array(width * rows.length);
    rows.forEach((row, y) => {
        [...row].forEach((value, x) => {
            occupied[y * width + x] = value === '#' ? 1 : 0;
        });
    });
    return { occupied, width, height: rows.length };
};

describe('mask contour extraction', () => {
    it('reduces a solid rectangle to one four-corner loop', () => {
        const mask = maskFromRows(['####', '####', '####']);
        const loops = extractLoopsFromMask(mask.occupied, mask.width, mask.height, 10, 20);

        expect(loops).toHaveLength(1);
        expect(loops[0]).toEqual([
            { x: 10, y: 20 },
            { x: 14, y: 20 },
            { x: 14, y: 23 },
            { x: 10, y: 23 },
        ]);
    });

    it('keeps a hole as an independent loop', () => {
        const mask = maskFromRows(['#####', '#...#', '#####']);
        const loops = extractLoopsFromMask(mask.occupied, mask.width, mask.height, 0, 0);

        expect(loops).toHaveLength(2);
        expect(loops.map((loop) => loop.length).sort((left, right) => left - right)).toEqual([4, 12]);
    });

    it('does not bridge separated regions', () => {
        const mask = maskFromRows(['##..##', '##..##']);
        const loops = extractLoopsFromMask(mask.occupied, mask.width, mask.height, 0, 0);

        expect(loops).toHaveLength(2);
        expect(loops.every((loop) => loop.length === 4)).toBe(true);
    });
});
