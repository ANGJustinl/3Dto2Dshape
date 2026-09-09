import { expect, it } from 'vitest';
import { buildPaintLayerParts } from './index';

type Args = Parameters<typeof buildPaintLayerParts>;
const settings = {
    lightDirection: [0,0,1], shadowThreshold: -0.1, highlightThreshold: 0.1,
    shadowStrength: 0.8, highlightStrength: 0.8,
} as Args[2];
const style = {focusLevel:'focal',macroGroup:'face'} as Args[3];
const part = (label: string): Args[0] => ({
    leafId:'eye-part',label,materialNames:[label],parentPath:'face',mesh:{} as Args[0]['mesh'],
    triangleCount:1,color:'#40383C',opacity:0.3,
    triangles:[{vertexIndices:[0,1,2],vertexPositionKeys:['a','b','c']}],
});
const pose = (direction: number): Args[1] => ({
    worldX:Float32Array.from([0,1,0]), worldY:Float32Array.from([0,0,direction]),
    worldZ:Float32Array.from([0,0,0]),
} as Args[1]);

it('keeps eye-shadow color, alpha and layer identity fixed across changed/degenerated normals', () => {
    for (const name of ['目影','眼影','Eye_Shadow','目影-20']) {
        for (const direction of [-1,0,1]) {
            const source=part(name);
            const result=buildPaintLayerParts(source,pose(direction),settings,style);
            expect(result).toHaveLength(1);
            expect(result[0].paintLayer).toBe('base');
            expect(result[0].leafId).toBe('eye-part::base');
            expect(result[0].color).toBe(source.color);
            expect(result[0].opacity).toBe(0.3);
            expect(result[0].triangles).toEqual(source.triangles);
        }
    }
});

it('preserves dynamic shading for hair, clothing and non-shadow eye materials', () => {
    for (const label of ['髪','裙','睫','白目','hair_shadow']) {
        const dark=buildPaintLayerParts(part(label),pose(-1),settings,style)[0];
        const bright=buildPaintLayerParts(part(label),pose(1),settings,style)[0];
        expect(dark.paintLayer).toBe('shadow');
        expect(bright.paintLayer).toBe('highlight');
        expect(dark.color).not.toBe(bright.color);
    }
});
