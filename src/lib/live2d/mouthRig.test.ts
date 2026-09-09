import { describe, expect, it } from 'vitest';
import { buildMouthRig } from './mouthRig';
import { createPoseEvaluator, type FamilyKeyforms } from './keyforms';
import { defaultAssignment } from './paramMapping';
import type { DrawableDecomposition } from './decomposition';

const parts: DrawableDecomposition[] = ['口线', '颜', '齿', '目', 'body'].map(label => ({
    id: label, label, meshId: 'mesh', leafIds: [], vertexCount: 4, triangleCount: 2,
    triangles: Uint32Array.from([0,1,2,0,2,3]), meshVertexIndices: Uint32Array.from([0,1,2,3]),
}));
const neutral = parts.map(() => Float32Array.from([-10,0, 0,0, 10,0, 0,-30]));
neutral[0][7] = 0;
const family = (id: FamilyKeyforms['family']): FamilyKeyforms => ({
    family: id, default: 0, values: [0,0.5,1],
    displacements: [0,0.5,1].map(value => Float32Array.from({length:40}, (_, i) =>
        id === 'ParamMouthForm' ? value : i % 8 === 3 ? value * 8 : 0)),
});

describe('mouth combination rig', () => {
    it('authors six poses with shared aperture/lip/teeth motion and no eye or nose smile drift', () => {
        const source = { ParamMouthForm: family('ParamMouthForm'), ParamMouthOpenY: family('ParamMouthOpenY') };
        const rig = buildMouthRig(parts, neutral, source);
        expect(rig.joints[0].displacements).toHaveLength(6);
        expect(source.ParamMouthForm.displacements[2][0]).toBe(1); // No source mutation.
        const output = neutral.map(p => new Float32Array(p.length));
        const evaluate = createPoseEvaluator(parts, neutral, rig.families, rig.joints);
        for (const open of [0,0.25,0.5,0.75,1]) {
            evaluate.evaluate({...defaultAssignment(), ParamMouthForm:1, ParamMouthOpenY:open}, output);
            expect([...output[0].slice(0,6)]).toEqual([...output[1].slice(0,6)]);
            expect([...output[0].slice(0,6)]).toEqual([...output[2].slice(0,6)]);
            expect(output[0][1]).toBeLessThan(0); // Both corners lift, in screen coordinates.
            expect(output[0][5]).toBeLessThan(0);
            expect(output[0][0]).toBeLessThan(-10);
            expect(output[0][4]).toBeGreaterThan(10);
            expect(output[1][7]).toBe(-30); // Nose region stays untouched.
            expect(output[3][0]).toBe(-10);
            expect(output[4][0]).toBe(-10);
            evaluate.evaluate({...defaultAssignment(), ParamMouthForm:0, ParamMouthOpenY:open}, output);
            expect(output[0][1]).toBe(0);
            expect(output[0][3]).toBeCloseTo(open * 8);
        }
    });
    it('retains source behavior when no reliable lip landmark exists', () => {
        const source = { ParamMouthForm: family('ParamMouthForm'), ParamMouthOpenY: family('ParamMouthOpenY') };
        expect(buildMouthRig(parts.slice(1), neutral.slice(1), source)).toEqual({families:source,joints:[]});
    });
});
