import * as THREE from 'three';
import type { ProjectionPartSource } from '../modelParts';
import { drawableNeutralPositions, type DrawableDecomposition } from './decomposition';
import type { BakeSample, ResolvedFaceParam } from './types';
import type { GeometryFrameTransform } from './framing';
import type { AnatomicalHeadData } from './model';
import { createAnchoredHeadProjector, type AnchoredHeadRig } from './anchoredHeadRig';

export type AnatomicalHeadSource = { rig: AnchoredHeadRig; weightsByMesh: Map<string, Float32Array> };

/** Called while the bake driver holds neutral and the frontal camera is live. */
export function captureAnatomicalHeadSource(parts:ProjectionPartSource[],camera:THREE.PerspectiveCamera,neutral:BakeSample,drawables:DrawableDecomposition[],params:ResolvedFaceParam[]):AnatomicalHeadSource|undefined {
 const binding=params.find(p=>p.id==='ParamAngleX')?.resolved;
 const meshes=[...new Set(parts.map(p=>p.mesh))];
 const mesh=meshes.find(m=>m.uuid===binding?.meshId);
 if(!(mesh instanceof THREE.SkinnedMesh))return;
 const head=mesh.skeleton.bones.find(b=>b.name===binding?.boneName),parent=head?.parent;
 const face=drawables.find(d=>d.maskOnly&&d.meshId===mesh.uuid);
 if(!head||!parent||!(parent as THREE.Bone).isBone||!face)return;
 const {width,height}=neutral.viewport;
 const project=(world:THREE.Vector3)=>{const p=world.clone().project(camera);return[(p.x+1)*width/2,(1-p.y)*height/2];};
 const headWorld=head.getWorldPosition(new THREE.Vector3()),headView=headWorld.clone().applyMatrix4(camera.matrixWorldInverse);
 const positions=drawableNeutralPositions(face,neutral),faceBounds=[Infinity,Infinity,-Infinity,-Infinity];
 for(let i=0;i<positions.length;i+=2){faceBounds[0]=Math.min(faceBounds[0],positions[i]);faceBounds[1]=Math.min(faceBounds[1],positions[i+1]);faceBounds[2]=Math.max(faceBounds[2],positions[i]);faceBounds[3]=Math.max(faceBounds[3],positions[i+1]);}
 const position=mesh.geometry.getAttribute('position');
 const front=Array.from(face.meshVertexIndices,v=>mesh.localToWorld(mesh.applyBoneTransform(v,new THREE.Vector3().fromBufferAttribute(position,v))).applyMatrix4(camera.matrixWorldInverse).z-headView.z).filter(z=>z>0).sort((a,b)=>a-b);
 const weightsByMesh=new Map<string,Float32Array>();
 for(const sourceMesh of meshes){
  const count=sourceMesh.geometry.getAttribute('position').count,weights=new Float32Array(count);
  if(sourceMesh instanceof THREE.SkinnedMesh){
   const sourceHead=sourceMesh.skeleton.bones.find(b=>b===head)??sourceMesh.skeleton.bones.find(b=>b.name===head.name);
   const indices=sourceMesh.geometry.getAttribute('skinIndex'),skin=sourceMesh.geometry.getAttribute('skinWeight');
   if(sourceHead&&indices&&skin){
    const descendants=new Set<number>();sourceMesh.skeleton.bones.forEach((bone,i)=>{let p:THREE.Object3D|null=bone;while(p){if(p===sourceHead){descendants.add(i);break;}p=p.parent;}});
    for(let v=0;v<count;v++){let sum=0;for(let lane=0;lane<4;lane++)if(descendants.has(indices.getComponent(v,lane)))sum+=skin.getComponent(v,lane);weights[v]=Math.max(0,Math.min(1,sum));}
   }
  }else{let p:THREE.Object3D|null=sourceMesh;while(p){if(p===head){weights.fill(1);break;}p=p.parent;}}
  weightsByMesh.set(sourceMesh.uuid,weights);
 }
 const rig:AnchoredHeadRig={pivot:project(headWorld),neckBase:project(parent.getWorldPosition(new THREE.Vector3())),projectionCenter:[width/2,height/2],focal:height/2/Math.tan(THREE.MathUtils.degToRad(camera.fov/2)),distance:-headView.z,frontDepth:front[Math.floor(front.length*.95)]??0,faceBounds,basis:camera.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(head.getWorldQuaternion(new THREE.Quaternion())).toArray(),pitchScale:.65};
 createAnchoredHeadProjector(rig);
 return{rig,weightsByMesh};
}

export function frameAnatomicalHeadSource(source:AnatomicalHeadSource,drawables:Pick<DrawableDecomposition,'meshId'|'meshVertexIndices'>[],transform:Pick<GeometryFrameTransform,'scale'|'offsetX'|'offsetY'>):AnatomicalHeadData{
 const {scale,offsetX,offsetY}=transform;
 const point=(p:number[])=>[p[0]*scale+offsetX,p[1]*scale+offsetY];
 const b=source.rig.faceBounds;
 const rig={...source.rig,pivot:point(source.rig.pivot),neckBase:point(source.rig.neckBase),projectionCenter:point(source.rig.projectionCenter),focal:source.rig.focal*scale,faceBounds:[b[0]*scale+offsetX,b[1]*scale+offsetY,b[2]*scale+offsetX,b[3]*scale+offsetY]};
 const weights=drawables.map(d=>{const sourceWeights=source.weightsByMesh.get(d.meshId);if(!sourceWeights)throw new Error('Missing anatomical source mesh');return Float32Array.from(d.meshVertexIndices,v=>{const w=sourceWeights[v];if(w===undefined)throw new Error('Anatomical vertex index outside source mesh');return w;});});
 return{rig,weights,angleKeys:[-15,0,15]};
}
