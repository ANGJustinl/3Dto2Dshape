import type {DrawableDecomposition} from './decomposition';
import type {BakeBundle,BakeSample} from './types';

/** Preserve static foreground surfaces in an eye region, including hair
 * sharing a material/leaf with skin. Their paint renders above eye patches. */
export function buildEyeForeground(bundle:BakeBundle,drawables:DrawableDecomposition[]):DrawableDecomposition[]{
 const neutral=bundle.samples.find(s=>s.kind==='neutral');if(!neutral)return[];
 const result:DrawableDecomposition[]=[];
 const blinks=bundle.samples.filter(s=>(s.family==='ParamEyeLOpen'||s.family==='ParamEyeROpen')&&s.assignment[s.family]===0);
 const raster=(d:DrawableDecomposition,sample:BakeSample,regions:NonNullable<DrawableDecomposition['textureRevealRegions']>)=>{
  const vertices=sample.meshes.find(m=>m.meshId===d.meshId)!.vertices,depth=new Float32Array(sample.viewport.width*sample.viewport.height).fill(Infinity),width=sample.viewport.width;
  const visit=(tri:number[],callback:(p:number,z:number)=>void)=>{
   const [a,b,c]=tri.map(v=>d.meshVertexIndices[v]),ax=vertices.screenX[a],ay=vertices.screenY[a],bx=vertices.screenX[b],by=vertices.screenY[b],cx=vertices.screenX[c],cy=vertices.screenY[c],area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(area>=-1e-7)return;
   for(const r of regions)for(let y=Math.max(0,Math.floor(Math.max(r.y0,Math.min(ay,by,cy))));y<Math.min(sample.viewport.height,Math.ceil(Math.min(r.y1,Math.max(ay,by,cy))));y++)for(let x=Math.max(0,Math.floor(Math.max(r.x0,Math.min(ax,bx,cx))));x<Math.min(width,Math.ceil(Math.min(r.x1,Math.max(ax,bx,cx))));x++){
    const px=x+.5,py=y+.5,u=((bx-px)*(cy-py)-(by-py)*(cx-px))/area,v=((cx-px)*(ay-py)-(cy-py)*(ax-px))/area,w=1-u-v;if(u>=0&&v>=0&&w>=0)callback(y*width+x,u*vertices.depth[a]+v*vertices.depth[b]+w*vertices.depth[c]);
   }
  };
  for(let i=0;i<d.triangles.length;i+=3)visit(Array.from(d.triangles.subarray(i,i+3)),(p,z)=>depth[p]=Math.min(depth[p],z));
  return{depth,visit};
 };
 for(const skin of drawables.filter(d=>d.facialRole==='skin')){
  const regions=skin.textureRevealRegions??[];if(!regions.length)continue;
  const eyeParts=drawables.filter(d=>d.meshId===skin.meshId&&d.surfaceTexture),reference=new Float32Array(neutral.viewport.width*neutral.viewport.height).fill(Infinity);
  const owned=new Set(eyeParts.flatMap(d=>Array.from({length:d.triangleCount},(_,i)=>Array.from(d.triangles.subarray(i*3,i*3+3),v=>d.meshVertexIndices[v]).join(','))));
  for(const part of eyeParts){const depth=raster(part,neutral,regions).depth;for(let p=0;p<depth.length;p++)reference[p]=Math.min(reference[p],depth[p]);}
  for(const source of drawables.filter(d=>d.meshId===skin.meshId&&!d.surfaceTexture&&!d.maskOnly)){
   const vertices=neutral.meshes.find(m=>m.meshId===source.meshId)!.vertices;
   const {visit}=raster(source,neutral,regions),triangles:number[]=[];
   for(let i=0;i<source.triangles.length;i+=3){const tri=Array.from(source.triangles.subarray(i,i+3)),ids=tri.map(v=>source.meshVertexIndices[v]);if(owned.has(ids.join(',')))continue;
    if(blinks.some(s=>{const target=s.meshes.find(m=>m.meshId===source.meshId)!.vertices;return ids.some(v=>Math.hypot(vertices.screenX[v]-target.screenX[v],vertices.screenY[v]-target.screenY[v])>neutral.viewport.width*.00005);} ))continue;
    let foreground=false;visit(tri,(p,z)=>{if(Number.isFinite(reference[p])&&z<reference[p]-1e-7)foreground=true;});if(foreground)triangles.push(...tri);
   }
   if(!triangles.length)continue;
   // Separate head paint already contains its neutral visibility cutouts.
   // Render it once above the repaired face rather than painting an alpha
   // crop twice. Mixed face/body layers still need a local foreground mesh.
   if(source.rollAttachment?.length===source.vertexCount&&source.rollAttachment.every(w=>w>=.8)&&!drawables.some(d=>d.surfaceTexture&&d.surfaceSourceId===source.id)){
    source.facialForeground=true;continue;
   }
   const map=new Map<number,number>(),indices:number[]=[];const compact=triangles.map(v=>{if(!map.has(v)){map.set(v,indices.length);indices.push(source.meshVertexIndices[v]);}return map.get(v)!;});
   const d:DrawableDecomposition={...source,id:`${source.id}-eye-foreground`,label:`${source.label} [eye foreground]`,meshVertexIndices:Uint32Array.from(indices),triangles:Uint32Array.from(compact),vertexCount:indices.length,triangleCount:compact.length/3,headAttachment:undefined,rollAttachment:undefined,textureCutoutRegions:undefined,textureRevealRegions:regions,foregroundOnly:true,deformationSourceId:source.id};
   const depths=raster(d,neutral,regions).depth;
   d.textureCoverage=Uint8Array.from(depths,(z,p)=>Number(Number.isFinite(z)&&(!Number.isFinite(reference[p])||z<reference[p]-1e-7)));
   result.push(d);
  }
 }
 return result;
}
