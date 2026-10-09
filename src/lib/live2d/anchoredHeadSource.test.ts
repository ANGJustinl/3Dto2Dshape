import {expect,it} from 'vitest';
import * as THREE from 'three';
import {captureAnatomicalHeadSource,frameAnatomicalHeadSource} from './anchoredHeadSource';
import type {ProjectionPartSource} from '../modelParts';
import type {DrawableDecomposition} from './decomposition';
import type {BakeSample,ResolvedFaceParam} from './types';
function fixture(){
 const make=(fractions:number[])=>{
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,1.5,.2,.2,1.4,.3,-.2,1.3,.1],3));
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(fractions.flatMap(()=>[0,1,0,0]),4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(fractions.flatMap(w=>[1-w,w,0,0]),4));
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial()),neck=new THREE.Bone(),head=new THREE.Bone();neck.name='首';head.name='頭';head.position.y=1;neck.add(head);mesh.add(neck);mesh.bind(new THREE.Skeleton([neck,head]));mesh.updateMatrixWorld(true);mesh.skeleton.update();return mesh;
 };
 const first=make([.8,.1,1]),second=make([.2,1,0]);const parts:ProjectionPartSource[]=[first,second].map((mesh,i)=>({mesh,leafId:`mesh-${i}`,label:'skin',materialNames:[],parentPath:'',triangleCount:0,color:'#fff',triangles:[]}));
 const camera=new THREE.PerspectiveCamera(35,1,.1,100);camera.position.set(0,.5,10);camera.lookAt(0,.5,0);camera.updateMatrixWorld(true);
 const neutral={viewport:{width:100,height:100},meshes:[{meshId:first.uuid,vertices:{screenX:Float32Array.from([40,60,50]),screenY:Float32Array.from([20,30,80]),depth:new Float32Array(3)}}]} as BakeSample;
 const face={meshId:first.uuid,maskOnly:true,vertexCount:3,meshVertexIndices:Uint32Array.from([0,1,2])} as DrawableDecomposition;
 const params=[{id:'ParamAngleX',resolved:{meshId:first.uuid,boneName:'頭'}}] as ResolvedFaceParam[];
 return{parts,camera,neutral,face,params,first,second};
}
it('keeps source weights separate for meshes whose local vertex indices overlap',()=>{
 const f=fixture(),source=captureAnatomicalHeadSource(f.parts,f.camera,f.neutral,[f.face],f.params)!;
 const data=frameAnatomicalHeadSource(source,[{meshId:f.first.uuid,meshVertexIndices:Uint32Array.from([2,0])},{meshId:f.second.uuid,meshVertexIndices:Uint32Array.from([2,0])}],{scale:1,offsetX:0,offsetY:0});
 expect([...data.weights[0]]).toEqual([1,Math.fround(.8)]);expect([...data.weights[1]]).toEqual([0,Math.fround(.2)]);
 expect(data.rig.pivot[0]).toBeCloseTo(50);expect(data.rig.neckBase[1]).toBeGreaterThan(data.rig.pivot[1]);expect(data.rig.frontDepth).toBeCloseTo(.3,6);
});
it('frames the source joint and camera with the same scale and translation as paint',()=>{
 const f=fixture(),source=captureAnatomicalHeadSource(f.parts,f.camera,f.neutral,[f.face],f.params)!;
 const data=frameAnatomicalHeadSource(source,[f.face],{scale:2,offsetX:7,offsetY:-3});
 expect(data.rig.pivot).toEqual([source.rig.pivot[0]*2+7,source.rig.pivot[1]*2-3]);expect(data.rig.faceBounds).toEqual([87,37,127,157]);expect(data.rig.focal).toBe(source.rig.focal*2);expect(data.rig.distance).toBe(source.rig.distance);
 expect(()=>frameAnatomicalHeadSource(source,[{meshId:f.first.uuid,meshVertexIndices:Uint32Array.from([8])}],{scale:1,offsetX:0,offsetY:0})).toThrow('vertex index');
});
it('leaves models without a resolved head or facial surface on the legacy path',()=>{
 const f=fixture();expect(captureAnatomicalHeadSource(f.parts,f.camera,f.neutral,[],f.params)).toBeUndefined();expect(captureAnatomicalHeadSource(f.parts,f.camera,f.neutral,[f.face],[])).toBeUndefined();
});
