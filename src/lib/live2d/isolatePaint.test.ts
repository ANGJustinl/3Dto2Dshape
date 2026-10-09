import {expect,it} from 'vitest';
import {paintVisibilityMask} from './isolatePaint';
import type {ProjectedPartShape} from '../2DRenderShared/types';
const pixel=(shapes:ProjectedPartShape[])=>{let depth=Infinity,value=0;for(const s of shapes)if(s.depth<depth){const a=s.opacity??1;value=(s.color==='#FFFFFF'?1:0)*a+value*(1-a);depth=s.depth;}return value;};
it('erases an earlier backing mask when a nearer opaque surface is drawn later',()=>{
 const shapes=[{sourceLeafId:'back',depth:.8,opacity:1},{sourceLeafId:'front',depth:.4,opacity:1}] as ProjectedPartShape[];
 expect(pixel(paintVisibilityMask(shapes,new Set(['back'])))).toBe(0);
});
it('retains the original scene winner when duplicate surfaces have exactly equal depth',()=>{
 const shapes=[{sourceLeafId:'green',depth:.4,opacity:1},{sourceLeafId:'black',depth:.4,opacity:1}] as ProjectedPartShape[];
 expect(pixel(paintVisibilityMask(shapes,new Set(['green'])))).toBe(1);
 expect(pixel(paintVisibilityMask(shapes,new Set(['black'])))).toBe(0);
});
it('does not mutate source colors or opacities while preparing the visibility pass',()=>{
 const s={sourceLeafId:'a',color:'#123456',depth:.4,opacity:.3,previewFlatInk:true} as ProjectedPartShape;
 expect(paintVisibilityMask([s],new Set(['a']))[0]).toMatchObject({color:'#FFFFFF',opacity:1,previewFlatInk:false});
 expect(s).toMatchObject({color:'#123456',opacity:.3,previewFlatInk:true});
});
