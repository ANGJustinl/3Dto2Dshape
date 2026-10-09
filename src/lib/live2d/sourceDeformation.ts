import {drawableDisplacementOffsets,type FamilyKeyforms,type JointKeyforms} from './keyforms';
import type {DrawableDecomposition} from './decomposition';
/** Foreground geometry follows its original source, not a newly inferred rig. */
export function copySourceDeformation(drawables:DrawableDecomposition[],families:Record<string,FamilyKeyforms>,joints:JointKeyforms[]){
 const offsets=drawableDisplacementOffsets(drawables);
 for(let target=0;target<drawables.length;target++){
  const d=drawables[target];if(!d.deformationSourceId)continue;const source=drawables.findIndex(s=>s.id===d.deformationSourceId);if(source<0)throw new Error('Missing foreground deformation source');
  const map=new Map(Array.from(drawables[source].meshVertexIndices,(v,i)=>[v,i]));
  for(const block of [...Object.values(families).flatMap(f=>f.displacements),...joints.flatMap(j=>j.displacements)])for(let v=0;v<d.vertexCount;v++){
   const s=map.get(d.meshVertexIndices[v]);if(s===undefined)throw new Error('Missing foreground source vertex');block[offsets[target]+v*2]=block[offsets[source]+s*2];block[offsets[target]+v*2+1]=block[offsets[source]+s*2+1];
  }
 }
}
