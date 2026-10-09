import {expect,it} from 'vitest';
import {createAnchoredHeadProjector,createAnchoredHeadEvaluator,type AnchoredHeadRig} from './anchoredHeadRig';
import type {Live2dModel} from './model';
import type {ParamAssignment} from './types';
const rig:AnchoredHeadRig={pivot:[50,100],neckBase:[50,120],projectionCenter:[50,150],focal:500,distance:10,frontDepth:.5,faceBounds:[20,25,80,105],basis:[0,0,0,1],pitchScale:.65};
const pose=(x:number,y:number,z:number)=>({ParamAngleX:x,ParamAngleY:y,ParamAngleZ:z}) as ParamAssignment;
it('pins the anatomical head joint and stationary collar during yaw, pitch and roll',()=>{
 const p=createAnchoredHeadProjector(rig);
 for(const values of [[-10.5,0,0],[10.5,0,0],[0,10,0],[0,0,-10],[0,0,10],[-10,10,-10],[30,30,30]]){
  p.setPose(pose(...values as [number,number,number]));const head=p.project(50,100,1),collar=p.project(50,120,0);
  expect(head[0]).toBeCloseTo(50,10);expect(head[1]).toBeCloseTo(100,10);expect(collar).toEqual([50,120]);
 }
});
it('keeps neutral paint exact and gives yaw a turn cue without translating the joint',()=>{
 const p=createAnchoredHeadProjector(rig);p.setPose(pose(0,0,0));expect(p.project(44,65,.8)).toEqual([44,65]);
 p.setPose(pose(10.5,0,0));const nose=p.project(50,65,1),left=p.project(20,65,1),right=p.project(80,65,1);
 expect(nose[0]).toBeGreaterThan((left[0]+right[0])/2+.5);expect(p.project(50,100,1)[0]).toBeCloseTo(50,10);
});
it('uses a continuous shared neck transition and identical transforms for coincident layers',()=>{
 const p=createAnchoredHeadProjector(rig);p.setPose(pose(10,5,10));
 const a=p.project(48,108,.2),b=p.project(48,108,.20001),same=p.project(48,108,.2);
 expect(a).toEqual(same);expect(Math.hypot(a[0]-b[0],a[1]-b[1])).toBeLessThan(.001);
});
it('preserves the left-to-right ordering of the front surface for both yaw extremes',()=>{
 const p=createAnchoredHeadProjector(rig);
 for(const yaw of [-30,-10.5,10.5,30]){p.setPose(pose(yaw,0,0));for(const y of [25,45,65,85,100]){let previous=-Infinity;for(let x=20;x<=80;x+=.5){const out=p.project(x,y,1);expect(out[0]).toBeGreaterThan(previous);previous=out[0];}}}
});
it('uses the same anatomical projection at different model sizes and canvas offsets',()=>{
 const p=createAnchoredHeadProjector(rig),shift=[17,-3],move=(xy:number[])=>xy.map((v,i)=>v*2+shift[i%2]);
 const q=createAnchoredHeadProjector({...rig,pivot:move(rig.pivot),neckBase:move(rig.neckBase),projectionCenter:move(rig.projectionCenter),faceBounds:move(rig.faceBounds),focal:rig.focal*2});
 p.setPose(pose(10,-5,5));q.setPose(pose(10,-5,5));const a=p.project(44,65,.8),b=q.project(44*2+17,65*2-3,.8);
 expect(b[0]).toBeCloseTo(a[0]*2+17,10);expect(b[1]).toBeCloseTo(a[1]*2-3,10);
});
it('projects blinking paint and its coincident mask together without the previous head correction',()=>{
 const neutral=Float32Array.from([40,65,50,65,60,65]),closed=Float32Array.from([0,4,0,4,0,4,0,4,0,4,0,4]),zero=new Float32Array(12);
 const model={drawables:[{vertexCount:3,neutralPositions:neutral},{vertexCount:3,neutralPositions:neutral.slice()}],families:{ParamEyeLOpen:{family:'ParamEyeLOpen',default:1,values:[0,1],displacements:[closed,zero]},ParamAngleX:{family:'ParamAngleX',default:0,values:[-30,0,30],displacements:[Float32Array.from(zero,()=>-300),zero,Float32Array.from(zero,()=>300)]}},jointKeyforms:[]} as unknown as Live2dModel;
 const evaluator=createAnchoredHeadEvaluator(model,rig,[[1,1,1],[1,1,1]]),out=[new Float32Array(6),new Float32Array(6)];
 evaluator.evaluate({...pose(0,0,0),ParamEyeLOpen:0},out);expect([...out[0]]).toEqual([40,69,50,69,60,69]);
 evaluator.evaluate({...pose(10,5,5),ParamEyeLOpen:0},out);expect([...out[0]]).toEqual([...out[1]]);expect(Math.max(...out[0])).toBeLessThan(100);
});
