import type {DrawableDecomposition} from './decomposition';
import {drawableDisplacementOffsets,type FamilyKeyforms,type JointKeyforms} from './keyforms';

/** Apply the head's affine matrix to expression deltas as well as neutral
 * vertices. Otherwise rolled eyes close along screen Y and reopen at a corner. */
export function buildHeadExpressionJoints(drawables:DrawableDecomposition[],neutral:Float32Array[],families:Record<string,FamilyKeyforms>):JointKeyforms[]{
 const face=drawables.findIndex(d=>d.facialRole==='skin');if(face<0)return[];
 const offsets=drawableDisplacementOffsets(drawables),length=neutral.reduce((n,p)=>n+p.length,0),joints:JointKeyforms[]=[];
 const fit=(block:Float32Array)=>{
  const xy=neutral[face],count=xy.length/2;let sx=0,sy=0,tx=0,ty=0;
  for(let i=0;i<xy.length;i+=2){sx+=xy[i];sy+=xy[i+1];tx+=xy[i]+block[offsets[face]+i];ty+=xy[i+1]+block[offsets[face]+i+1];}sx/=count;sy/=count;tx/=count;ty/=count;
  let dot=0,cross=0,radius=0;for(let i=0;i<xy.length;i+=2){const x=xy[i]-sx,y=xy[i+1]-sy,u=xy[i]+block[offsets[face]+i]-tx,v=xy[i+1]+block[offsets[face]+i+1]-ty;dot+=x*u+y*v;cross+=x*v-y*u;radius+=x*x+y*y;}
  return{a:radius>1e-9?dot/radius:1,b:radius>1e-9?cross/radius:0};
 };
 const sample=(family:FamilyKeyforms,value:number)=>{
  if(family.values.length===1)return family.displacements[0];
  let hi=1;while(hi<family.values.length-1&&family.values[hi]<value)hi++;const lo=hi-1,t=Math.max(0,Math.min(1,(value-family.values[lo])/(family.values[hi]-family.values[lo])));
  return Float32Array.from(family.displacements[lo],(v,i)=>v+(family.displacements[hi][i]-v)*t);
 };
 for(const headId of ['ParamAngleX','ParamAngleZ']){
  const head=families[headId];if(!head)continue;
  const xValues=[...new Set([head.values[0],head.default,head.values.at(-1)!])].sort((a,b)=>a-b);if(xValues.length<2)continue;
  for(const expression of Object.values(families).filter(f=>/^Param(?:Eye|Mouth)/.test(f.family))){
   const min=expression.values[0],max=expression.values.at(-1)!;if(!(max>min))continue;
   const yValues=[...new Set([min,(min+max)/2,max,expression.default])].sort((a,b)=>a-b);
   const blocks:Float32Array[]=[];
   for(const y of yValues){const delta=sample(expression,y);for(const x of xValues){const {a,b}=fit(sample(head,x)),block=new Float32Array(length);
    drawables.forEach((d,index)=>{for(let v=0;v<d.vertexCount;v++){const weight=headId==='ParamAngleZ'?(d.rollAttachment?.[v]??(d.facialRole?1:0)):(d.headAttachment?.[v]??(d.facialRole?1:0));if(!weight)continue;const i=offsets[index]+v*2,dx=delta[i],dy=delta[i+1];block[i]=weight*((a-1)*dx-b*dy);block[i+1]=weight*(b*dx+(a-1)*dy);}});blocks.push(block);
   }}
   if(blocks.some(p=>p.some(v=>Math.abs(v)>1e-6)))joints.push({x:{family:head.family,default:head.default,values:xValues},y:{family:expression.family,default:expression.default,values:yValues},displacements:blocks});
  }
 }
 return joints;
}
