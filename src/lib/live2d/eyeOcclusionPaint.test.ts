import {expect,it} from 'vitest';
import {buildEyeOcclusion} from './eyeOcclusion';
import type {BakeBundle} from './types';
import type {DrawableDecomposition} from './decomposition';

const fixture=(large=false)=>{
 const xy=[0,0,100,0,100,100,0,100,40,45,60,45,60,55,40,55,...(large?[-50,-50,150,-50,150,150,-50,150]:[42,46,58,46,58,54,42,54])];
 const vertices=(closed:boolean)=>({screenX:Float32Array.from(xy.filter((_,i)=>i%2===0)),screenY:Float32Array.from(xy.filter((_,i)=>i%2===1).map((y,i)=>closed&&i>=4&&i<8?50:y)),depth:Float32Array.from({length:12},(_,i)=>i<8?.1:.2)});
 const bundle={params:[],parts:[],samples:[{kind:'neutral',assignment:{ParamEyeLOpen:1},viewport:{width:100,height:100},meshes:[{meshId:'m',vertices:vertices(false)}]},{kind:'family',family:'ParamEyeLOpen',assignment:{ParamEyeLOpen:0},viewport:{width:100,height:100},meshes:[{meshId:'m',vertices:vertices(true)}]}]} as unknown as BakeBundle;
 const skin:DrawableDecomposition={id:'skin',label:'material-42',meshId:'m',leafIds:['a'],vertexCount:8,meshVertexIndices:Uint32Array.from([0,1,2,3,4,5,6,7]),triangleCount:8,triangles:Uint32Array.from([0,5,1,0,4,5,1,6,2,1,5,6,2,7,3,2,6,7,3,4,0,3,7,4]),facialRole:'skin'};
 const eye:DrawableDecomposition={id:'eye',label:'material-99',meshId:'m',leafIds:['b'],vertexCount:4,meshVertexIndices:Uint32Array.from([8,9,10,11]),triangleCount:2,triangles:Uint32Array.from([0,2,1,0,3,2]),facialRole:'feature'};
 return{bundle,skin,eye};
};
it('uses painted alpha when an eye mesh has large transparent geometry outside the face',()=>{
 const {bundle,skin,eye}=fixture(true);
 expect(buildEyeOcclusion(bundle,[skin,eye]).targets.has('eye')).toBe(false);
 const rgba=new Uint8Array(100*100*4);for(let y=46;y<54;y++)for(let x=42;x<58;x++)rgba[(y*100+x)*4+3]=255;
 const paint=new Map([['eye',{texture:{width:100,height:100,rgba},cropX:0,cropY:0,scale:1}]]);
 expect(buildEyeOcclusion(bundle,[skin,eye],paint).targets.has('eye')).toBe(true);
});
it('retains skin triangles that can face the viewer during blink instead of fixing neutral winding forever',()=>{
 const {bundle,skin,eye}=fixture();skin.triangles=Uint32Array.from([...skin.triangles,4,5,6]);skin.triangleCount++;
 const mask=buildEyeOcclusion(bundle,[skin,eye]).maskers[0];
 expect(Array.from(mask.triangles.slice(-3))).toEqual([4,5,6]);
});
it('masks an eye surface that turns entirely away from the viewer when closed',()=>{
 const {bundle,skin,eye}=fixture(),closed=bundle.samples[1].meshes[0].vertices;
 closed.screenX.set([58,42,42,58],8);
 expect(buildEyeOcclusion(bundle,[skin,eye]).targets.has('eye')).toBe(true);
});
it('checks both sides of features because the exported eye paint is double sided',()=>{
 const {bundle,skin,eye}=fixture();
 eye.triangles=Uint32Array.from([0,1,2,0,2,3]);
 expect(buildEyeOcclusion(bundle,[skin,eye]).targets.has('eye')).toBe(true);
});
it('masks eye paint already hidden by skin in the neutral pose',()=>{
 const {bundle,skin,eye}=fixture();
 for(const sample of bundle.samples)sample.meshes[0].vertices.screenX.set([20,30,30,20],8);
 const rgba=new Uint8Array(100*100*4).fill(255);
 expect(buildEyeOcclusion(bundle,[skin,eye],new Map([['eye',{texture:{width:100,height:100,rgba},cropX:0,cropY:0,scale:1}]])).targets.has('eye')).toBe(true);
});
