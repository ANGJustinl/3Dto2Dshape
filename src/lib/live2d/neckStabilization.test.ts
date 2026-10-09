import {expect,it} from 'vitest';
import {stabilizeNeckKeyforms,type HeadSkinWeights} from './neckStabilization';
import type {FamilyKeyforms} from './keyforms';

const fixture=()=>{
 const drawables=[{meshId:'m',vertexCount:4,meshVertexIndices:Uint32Array.from([0,1,2,3])},{meshId:'m',vertexCount:5,meshVertexIndices:Uint32Array.from([4,5,6,7,8])}];
 const neutral=[Float32Array.from([0,0,10,0,0,10,10,10]),Float32Array.from([5,12,5,12,5,17,5,14,30,12])];
 const weights:HeadSkinWeights=new Map([['m',new Map([[4,.4],[5,.4],[6,0],[7,.9],[8,.4]])]]);
 const family:FamilyKeyforms={family:'ParamAngleX',default:0,values:[-10,0,10],displacements:[-1,0,1].map(sign=>Float32Array.from([4*sign,0,4*sign,0,4*sign,0,4*sign,0,-20*sign,0,20*sign,0,0,0,4*sign,0,10*sign,0]))};
 return{drawables,neutral,weights,family};
};
it('keeps overlapping front/back neck paint together for equal left and right turns',()=>{
 const f=fixture(),result=stabilizeNeckKeyforms(f.drawables,f.neutral,{ParamAngleX:f.family},0,f.weights);
 expect(result.verticesChanged).toBe(2);
 const left=result.families.ParamAngleX.displacements[0],right=result.families.ParamAngleX.displacements[2];
 expect(left[8]).toBe(left[10]);expect(right[8]).toBe(right[10]);expect(left[8]).toBe(-right[8]);
 expect(Math.abs(right[8])).toBeLessThan(Math.abs(right[0]));
 expect([...f.family.displacements[0].slice(8,12)]).toEqual([20,0,-20,0]);
});
it('preserves the collar, full head attachment, distant paint, neutral pose and blink',()=>{
 const f=fixture(),blink={...f.family,family:'ParamEyeLOpen' as const};
 const result=stabilizeNeckKeyforms(f.drawables,f.neutral,{ParamAngleX:f.family,ParamEyeLOpen:blink},0,f.weights);
 expect(result.families.ParamEyeLOpen).toBe(blink);
 for(let k=0;k<3;k++){
  const out=result.families.ParamAngleX.displacements[k],source=f.family.displacements[k];
  expect([...out.slice(0,8)]).toEqual([...source.slice(0,8)]);
  expect([...out.slice(12)]).toEqual([...source.slice(12)]);
 }
 expect([...result.families.ParamAngleX.displacements[1]]).toEqual(new Array(18).fill(0));
});
it('requires anatomical weights from the same mesh before changing a transition',()=>{
 const f=fixture(),families={ParamAngleX:f.family};
 expect(stabilizeNeckKeyforms(f.drawables,f.neutral,families,0,new Map([['other',f.weights.get('m')!]])).families).toBe(families);
 expect(stabilizeNeckKeyforms(f.drawables,f.neutral,families,-1,f.weights).families).toBe(families);
});
