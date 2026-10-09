import {expect,it} from 'vitest';
import {decomposeDrawables} from './decomposition';
import {buildEyeOcclusion} from './eyeOcclusion';
import {finalEyeTextureLayers} from './build';
import {facialFixture} from './facialSurfaces.fixture';
import type {DrawableDecomposition} from './decomposition';
it('retains a static eye with transparent support until painted occlusion selects its final layer',()=>{
 const bundle=facialFixture();bundle.parts[0].headVertexIndices=Array.from({length:12},(_,i)=>i);
 for(const sample of bundle.samples){sample.meshes[0].vertices.screenX.set([-10,110,110,-10],8);sample.meshes[0].vertices.screenY.set([-10,-10,110,110],8);}
 const candidates=decomposeDrawables(bundle),eye=candidates.find(d=>d.facialRole==='feature')!;
 expect(eye.blinkSupport).toBe(false);
 expect(buildEyeOcclusion(bundle,candidates).targets.has(eye.id)).toBe(false);
 const rgba=new Uint8Array(300*300*4);for(let y=45;y<55;y++)for(let x=40;x<60;x++)rgba[(y*300+x)*4+3]=255;
 const painted=buildEyeOcclusion(bundle,candidates,new Map([[eye.id,{texture:{width:300,height:300,rgba},cropX:0,cropY:0,scale:1}]]));
 expect(painted.targets.has(eye.id)).toBe(true);
 expect(finalEyeTextureLayers(bundle,candidates,painted.targets).some(d=>d.id===eye.id)).toBe(true);
});
it('keeps independent head paint continuous instead of applying eye-window patches to it',()=>{
 const source={id:'material-7',meshId:'m',surfaceTexture:false,rollAttachment:Float32Array.from([1,1,1]),textureCutoutRegions:[{x0:2,y0:2,x1:4,y1:4}]} as DrawableDecomposition;
 const patch={...source,id:'patch',surfaceTexture:true,surfaceSourceId:source.id,facialRole:'feature' as const,blinkSupport:false};
 const result=finalEyeTextureLayers({...facialFixture(),samples:[]},[source,patch],new Map([['patch',['mask']]]),new Map([[source.id,{texture:{width:3,height:3,rgba:new Uint8Array(36).fill(255)},scale:1}]]));
 expect(result.map(d=>d.id)).toEqual([source.id]);expect(source.facialForeground).not.toBe(true);expect(source.textureCutoutRegions).toBeUndefined();
});
