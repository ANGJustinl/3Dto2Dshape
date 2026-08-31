import { describe, expect, it } from 'vitest';
import { rankByDepthFlips } from './order';

describe('rankByDepthFlips', () => {
    it('keeps the neutral order when depth changes stay within the margin', () => {
        // back hair wraps the head: its evaluated median stays statistically
        // tied with the face — noise must not paint it over the face.
        const neutralOrder = [0, 1, 2]; // back hair, face, front hair
        const evaluated = [5.0, 5.01, 4.0]; // back hair noise-flips by 0.01
        const ranks = rankByDepthFlips(neutralOrder, evaluated, 0.1);
        expect(ranks).toEqual([0, 1, 2]);
    });

    it('inverts a pair whose depth flipped decisively', () => {
        // side hair (2) swings behind the face at this angle
        const neutralOrder = [0, 1, 2];
        const evaluated = [5.0, 5.02, 8.0];
        const ranks = rankByDepthFlips(neutralOrder, evaluated, 0.1, [false, false, true]);
        // far-to-near: 2 (8.0), 0 (5.0), 1 (5.02)
        expect(ranks[2]).toBe(0);
        expect(ranks[0]).toBe(1);
        expect(ranks[1]).toBe(2);
    });

    it('keeps overlay features above the face even on decisive flips', () => {
        // neutral: face(0) then eye(1). At the pose the eye's recessed
        // median depth flips decisively behind the face skin — the eye is
        // not an occlusion drawable, so the PSD stacking must hold.
        const ranks = rankByDepthFlips([0, 1], [5.0, 8.0], 0.1, [false, false]);
        expect(ranks).toEqual([0, 1]);
    });

    it('reorders a hair drawable across a static face on decisive flips', () => {
        const ranks = rankByDepthFlips([0, 1], [5.0, 8.0], 0.1, [false, true]);
        expect(ranks).toEqual([1, 0]);
    });

    it('resolves cyclic depth noise by falling back to neutral order', () => {
        // A>B, B>C, C>A is unresolvable; neutral-earliest advances first.
        const neutralOrder = [0, 1, 2];
        const evaluated = [3.0, 2.0, 1.0];
        const ranks = rankByDepthFlips(neutralOrder, evaluated, 0.1);
        // 2 before 1 before 0: consistent total order here (2 farthest... )
        // evaluated desc: 0 farthest -> expected 0,1,2? 0(3)>1(2)>2(1):
        // pairs: 0 before 1, 1 before 2, 0 before 2 -> order 0,1,2
        expect(ranks).toEqual([0, 1, 2]);
    });
});
