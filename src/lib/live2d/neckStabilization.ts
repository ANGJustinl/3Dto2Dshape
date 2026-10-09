import type {FamilyKeyforms} from './keyforms';

type NeckDrawable={meshId:string;vertexCount:number;meshVertexIndices:Uint32Array};
export type HeadSkinWeights=Map<string,Map<number,number>>;

/** Keep the transition between a stabilized 2D head and its stationary collar
 * in the same projection plane. Raw 3D residuals on front/back neck vertices
 * otherwise fan apart underneath a head whose perspective was removed. */
export function stabilizeNeckKeyforms(
 drawables:NeckDrawable[],neutral:Float32Array[],families:Record<string,FamilyKeyforms>,
 headAnchorIndex:number,weights:HeadSkinWeights,
):{families:Record<string,FamilyKeyforms>;verticesChanged:number}{
 const face=neutral[headAnchorIndex];if(!face?.length)return{families,verticesChanged:0};
 let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(let i=0;i<face.length;i+=2){minX=Math.min(minX,face[i]);maxX=Math.max(maxX,face[i]);minY=Math.min(minY,face[i+1]);maxY=Math.max(maxY,face[i+1]);}
 const height=maxY-minY,width=maxX-minX;if(!(height>0&&width>0))return{families,verticesChanged:0};
 const offsets:number[]=[];let length=0;for(const d of drawables){offsets.push(length);length+=d.vertexCount*2;}
 const transitions:Array<{packed:number;x:number;y:number;weight:number}>=[];
 drawables.forEach((d,index)=>{
  const binding=weights.get(d.meshId);if(!binding)return;
  for(let v=0;v<d.vertexCount;v++){
   const weight=binding.get(d.meshVertexIndices[v])??0,x=neutral[index][v*2],y=neutral[index][v*2+1];
   // The existing face surface comprises vertices at or above 80% attachment.
   // Its neighboring partial vertices identify the neck without material names.
   if(weight<=0||weight>=.8||x<minX+width*.1||x>maxX-width*.1||y<maxY-height*.15||y>maxY+height*.7)continue;
   transitions.push({packed:offsets[index]+v*2,x,y,weight:weight/.8});
  }
 });
 if(!transitions.length)return{families,verticesChanged:0};
 const fit=(block:Float32Array)=>{
  let sx=0,sy=0,tx=0,ty=0;const count=face.length/2,offset=offsets[headAnchorIndex];
  for(let i=0;i<face.length;i+=2){sx+=face[i];sy+=face[i+1];tx+=face[i]+block[offset+i];ty+=face[i+1]+block[offset+i+1];}sx/=count;sy/=count;tx/=count;ty/=count;
  let radius=0,dot=0,cross=0;
  for(let i=0;i<face.length;i+=2){const x=face[i]-sx,y=face[i+1]-sy,u=face[i]+block[offset+i]-tx,v=face[i+1]+block[offset+i+1]-ty;radius+=x*x+y*y;dot+=x*u+y*v;cross+=x*v-y*u;}
  const a=radius>1e-9?dot/radius:1,b=radius>1e-9?cross/radius:0;return{a,b,x:tx-a*sx+b*sy,y:ty-b*sx-a*sy};
 };
 const result={...families};
 for(const id of ['ParamAngleX','ParamAngleY','ParamAngleZ']){
  const family=families[id];if(!family)continue;
  result[id]={...family,displacements:family.displacements.map(block=>{
   const transform=fit(block),out=new Float32Array(block);
   for(const p of transitions){out[p.packed]=p.weight*(transform.a*p.x-transform.b*p.y+transform.x-p.x);out[p.packed+1]=p.weight*(transform.b*p.x+transform.a*p.y+transform.y-p.y);}
   return out;
  })};
 }
 return{families:result,verticesChanged:transitions.length};
}
