import * as THREE from 'three';
import {createPoseEvaluator,type PoseEvaluator} from './keyforms';
import type {Live2dModel} from './model';
import type {ParamAssignment} from './types';

export type AnchoredHeadRig={
 pivot:number[];neckBase:number[];projectionCenter:number[];focal:number;distance:number;
 frontDepth:number;faceBounds:number[];basis:number[];pitchScale:number;
};
const clamp=(value:number)=>Math.max(0,Math.min(1,value));
const headIds=new Set(['ParamAngleX','ParamAngleY','ParamAngleZ']);

/** A shared surface projection around the source skeleton's fixed head joint.
 * The jaw's depth tends to zero at the joint, while the cheek/eye plane carries
 * a bounded depth cue. Coincident paint, mask and feature vertices therefore
 * use the same projection rather than inheriting rear-surface perspective. */
export function createAnchoredHeadProjector(rig:AnchoredHeadRig){
 const [cx,cy]=rig.projectionCenter,[px,py]=rig.pivot,[x0,y0,x1,y1]=rig.faceBounds;
 if(rig.pivot.length!==2||rig.neckBase.length!==2||rig.projectionCenter.length!==2||rig.faceBounds.length!==4||rig.basis.length!==4||![cx,cy,px,py,x0,y0,x1,y1,rig.focal,rig.distance,rig.frontDepth,rig.pitchScale,...rig.basis,...rig.neckBase].every(Number.isFinite)||!(rig.focal>0&&rig.distance>0&&x1>x0&&y1>y0)||rig.basis.every(v=>v===0))throw new Error('Invalid anatomical head rig');
 const pivot=new THREE.Vector3((px-cx)*rig.distance/rig.focal,-(py-cy)*rig.distance/rig.focal,-rig.distance);
 const midX=(x0+x1)/2,midY=(y0+y1)/2,halfWidth=(x1-x0)/2,halfHeight=(y1-y0)/2;
 // Bound surface slope so yaw remains one-to-one throughout the ±30° range.
 const depth=Math.min(Math.max(0,rig.frontDepth),halfWidth*rig.distance/rig.focal*.65);
 const basis=new THREE.Quaternion(...rig.basis as [number,number,number,number]).normalize(),inverseBasis=basis.clone().invert();
 const rotation=new THREE.Quaternion(),q=new THREE.Quaternion(),point=new THREE.Vector3(),rotated=new THREE.Vector3();
 let neutral=true;
 const setPose=(assignment:ParamAssignment)=>{
  const yaw=assignment.ParamAngleX??0,pitch=assignment.ParamAngleY??0,roll=assignment.ParamAngleZ??0;
  neutral=yaw===0&&pitch===0&&roll===0;
  rotation.copy(basis).multiply(q.setFromAxisAngle(new THREE.Vector3(0,1,0),THREE.MathUtils.degToRad(yaw)))
   .multiply(q.setFromAxisAngle(new THREE.Vector3(1,0,0),THREE.MathUtils.degToRad(-pitch*rig.pitchScale)))
   .multiply(q.setFromAxisAngle(new THREE.Vector3(0,0,1),THREE.MathUtils.degToRad(roll))).multiply(inverseBasis);
 };
 const project=(x:number,y:number,weight:number):[number,number]=>{
  if(neutral||weight<=0)return[x,y];
  const u=(x-midX)/halfWidth,v=(y-midY)/halfHeight;
  const lower=clamp((py-y)/Math.max(1,py-midY)),taper=lower*lower*(3-2*lower);
  const z=depth*Math.max(0,1-u*u)*Math.max(0,1-v*v)*taper;
  point.set((x-cx)*(rig.distance-z)/rig.focal,-(y-cy)*(rig.distance-z)/rig.focal,-rig.distance+z);
  rotated.copy(point).sub(pivot).applyQuaternion(rotation).add(pivot);
  point.lerp(rotated,clamp(weight));const distance=-point.z;
  return[cx+point.x*rig.focal/distance,cy-point.y*rig.focal/distance];
 };
 return{setPose,project,depth};
}

/** Used as an export evaluator for an isolated native experiment. Expressions
 * are evaluated first, then projected together with their masks and skin. */
export function createAnchoredHeadEvaluator(model:Live2dModel,rig:AnchoredHeadRig,weights:ReadonlyArray<ArrayLike<number>>):PoseEvaluator{
 if(weights.length!==model.drawables.length||weights.some((w,i)=>w.length!==model.drawables[i].vertexCount||Array.from(w).some(v=>!Number.isFinite(v)||v<0||v>1.00001)))throw new Error('Anatomical weights do not match drawables');
 const families=Object.fromEntries(Object.entries(model.families).filter(([id])=>!headIds.has(id)));
 const joints=(model.jointKeyforms??[]).filter(j=>!headIds.has(j.x.family)&&!headIds.has(j.y.family));
 const expression=createPoseEvaluator(model.drawables,model.drawables.map(d=>d.neutralPositions),families,joints),projector=createAnchoredHeadProjector(rig);
 return{familyIds:Object.keys(model.families),evaluate:(assignment,outputs)=>{
  expression.evaluate(assignment,outputs);projector.setPose(assignment);
  model.drawables.forEach((d,index)=>{for(let v=0;v<d.vertexCount;v++){const p=projector.project(outputs[index][v*2],outputs[index][v*2+1],weights[index][v]);outputs[index][v*2]=p[0];outputs[index][v*2+1]=p[1];}});
 }};
}

/** One entry point for new bakes, saved files, preview and native export. */
export function createModelPoseEvaluator(model:Live2dModel):PoseEvaluator{
 if(model.headRig){
  const keys=model.headRig.angleKeys;
  if(keys.length<2||!keys.includes(0)||!keys.every((v,i)=>Number.isFinite(v)&&(i===0||v>keys[i-1]))||model.params.some(p=>headIds.has(p.id)&&(p.min<keys[0]||p.max>keys[keys.length-1])))throw new Error('Anatomical angle grid does not cover model parameters');
 }
 return model.headRig?createAnchoredHeadEvaluator(model,model.headRig.rig,model.headRig.weights):createPoseEvaluator(model.drawables,model.drawables.map(d=>d.neutralPositions),model.families,model.jointKeyforms);
}
