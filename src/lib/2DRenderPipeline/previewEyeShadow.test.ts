import { expect, it } from 'vitest';
import { previewEyeShadow } from './previewEyeShadow';
import type { ProjectedPartShape } from '../2DRenderShared/types';
import type { ProjectionPartSource } from '../modelParts';

it('renders black opaque eye shadow only in a display copy, leaving export alpha/color unchanged', () => {
    const shape = {sourceLeafId:'eye',color:'#40383C',opacity:0.3,
        edgeProfile:{mode:'soft',hardness:0.5,openness:0.2,seed:1}} as ProjectedPartShape;
    const hair = {...shape,sourceLeafId:'hair'};
    const parts = [{leafId:'eye',label:'目影',materialNames:['目影']},
        {leafId:'hair',label:'髪',materialNames:['髪']}] as ProjectionPartSource[];
    const result = previewEyeShadow([shape,hair],parts);
    expect(result[0]).toMatchObject({color:'#000000',opacity:1,previewFlatInk:true,edgeProfile:{mode:'hard',hardness:1,openness:0}});
    expect(result[0]).not.toBe(shape);
    expect(result[1]).toBe(hair);
    expect(shape.color).toBe('#40383C');
    expect(shape.opacity).toBe(0.3);
    expect(shape.previewFlatInk).toBeUndefined();
    expect(shape.edgeProfile.mode).toBe('soft');
    expect(previewEyeShadow([shape,hair],parts)).toEqual(result);
});
