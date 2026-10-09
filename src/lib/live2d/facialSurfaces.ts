import type {DrawableDecomposition} from './decomposition';
import type {BakeBundle,BakeSample} from './types';
import type {ProjectionPartSource} from '../modelParts';

type Box={x0:number;y0:number;x1:number;y1:number};
type Island={source:DrawableDecomposition;vertices:number[];triangles:number[];box:Box;moving:number};

/** Topology, not projected proximity: coincident pixels need not be welded vertices. */
export function splitFacialSurfaces(bundle:BakeBundle,drawables:DrawableDecomposition[]):DrawableDecomposition[]{
 const neutral=bundle.samples.find(s=>s.kind==='neutral');
 const blinks=bundle.samples.filter(s=>(s.family==='ParamEyeLOpen'||s.family==='ParamEyeROpen')&&s.assignment[s.family]===0);
 if(!neutral||!blinks.length)return drawables;
 const islands:Island[]=[];
 for(const source of drawables){
  const mesh=neutral.meshes.find(m=>m.meshId===source.meshId);if(!mesh)continue;
  const headParts=bundle.parts.filter(p=>p.meshId===source.meshId&&p.headVertexIndices!==undefined);
  const headVertices=headParts.length?new Set(headParts.flatMap(p=>p.headVertexIndices!)):null;
  const headTriangles=Array.from({length:source.triangleCount},(_,t)=>Array.from(source.triangles.subarray(t*3,t*3+3))).filter(tri=>!headVertices||tri.every(v=>headVertices.has(source.meshVertexIndices[v])));
  const parents=Array.from({length:source.vertexCount},(_,i)=>i);
  const root=(i:number):number=>{while(parents[i]!==i){parents[i]=parents[parents[i]];i=parents[i];}return i;};
  for(const tri of headTriangles){const a=root(tri[0]);parents[root(tri[1])]=a;parents[root(tri[2])]=a;}
  const groups=new Map<number,{vertices:number[];triangles:number[]}>();
  for(let i=0;i<source.vertexCount;i++){const r=root(i),group=groups.get(r)??{vertices:[],triangles:[]};group.vertices.push(i);groups.set(r,group);}
  for(const tri of headTriangles)groups.get(root(tri[0]))!.triangles.push(...tri);
  for(const group of groups.values()){
   if(!group.triangles.length)continue;
   const box:Box={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};let moving=0;
   for(const local of group.vertices){const v=source.meshVertexIndices[local],x=mesh.vertices.screenX[v],y=mesh.vertices.screenY[v];box.x0=Math.min(box.x0,x);box.y0=Math.min(box.y0,y);box.x1=Math.max(box.x1,x);box.y1=Math.max(box.y1,y);
    if(blinks.some(s=>{const target=s.meshes.find(m=>m.meshId===source.meshId)?.vertices;return target&&Math.hypot(target.screenX[v]-x,target.screenY[v]-y)>neutral.viewport.width*0.00005;}))moving++;
   }
   islands.push({source,...group,box,moving});
  }
 }
 // The enclosing skin surface is larger than its moving lashes/sclera.
 // A missing or ambiguous blink signal preserves the original decomposition.
 const anchors=new Map<string,Island>();
 for(const island of islands.filter(i=>i.moving>=2)){
  const v=neutral.meshes.find(m=>m.meshId===island.source.meshId)!.vertices;
  if(!bundle.parts.some(p=>p.meshId===island.source.meshId&&p.headVertexIndices!==undefined)){
   const support:Box={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
   for(const local of island.vertices){const index=island.source.meshVertexIndices[local];for(const sample of blinks){const target=sample.meshes.find(m=>m.meshId===island.source.meshId)!.vertices;if(Math.hypot(v.screenX[index]-target.screenX[index],v.screenY[index]-target.screenY[index])<=neutral.viewport.width*.00005)continue;for(const p of [v,target]){support.x0=Math.min(support.x0,p.screenX[index]);support.x1=Math.max(support.x1,p.screenX[index]);support.y0=Math.min(support.y0,p.screenY[index]);support.y1=Math.max(support.y1,p.screenY[index]);}}}
   // Without a skeleton binding, reject a face signal embedded in a much
   // larger connected body instead of fitting body vertices as head landmarks.
   if(island.box.x1-island.box.x0>Math.max(1,support.x1-support.x0)*6||island.box.y1-island.box.y0>Math.max(1,support.y1-support.y0)*6)continue;
  }
  if(!island.triangles.some((_,index)=>{if(index%3)return false;const [a,b,c]=island.triangles.slice(index,index+3).map(i=>island.source.meshVertexIndices[i]);return Math.abs((v.screenX[b]-v.screenX[a])*(v.screenY[c]-v.screenY[a])-(v.screenY[b]-v.screenY[a])*(v.screenX[c]-v.screenX[a]))>1e-6;}))continue;
  const size=(i:Island)=>(i.box.x1-i.box.x0)*(i.box.y1-i.box.y0);
  const prev=anchors.get(island.source.meshId);if(!prev||size(island)>size(prev))anchors.set(island.source.meshId,island);
 }
 if(!anchors.size)return drawables;
 const result:DrawableDecomposition[]=[];
 for(const source of drawables){
  const anchor=anchors.get(source.meshId);if(!anchor){result.push(source);continue;}
  const box=anchor.box,w=box.x1-box.x0,h=box.y1-box.y0;
  const headParts=bundle.parts.filter(p=>p.meshId===source.meshId&&p.headVertexIndices!==undefined);
  const headVertices=headParts.length?new Set(headParts.flatMap(p=>p.headVertexIndices!)):null;
  if(!(w>0&&h>0)){result.push(source);continue;}
  let selected=islands.filter(i=>i.source===source).filter(i=>i===anchor||((!headVertices||i.vertices.filter(v=>headVertices.has(source.meshVertexIndices[v])).length/i.vertices.length>=.8)&&
   i.box.x1-i.box.x0<=w*1.2&&i.box.y1-i.box.y0<=h*1.2&&
   i.box.x0>=box.x0-w*.12&&i.box.x1<=box.x1+w*.12&&i.box.y0>=box.y0-h*.12&&i.box.y1<=box.y1+h*.12));
  if(!selected.length){result.push(source);continue;}
  const textureRevealRegions=blinks.map(sample=>{
   const base=neutral.meshes.find(m=>m.meshId===source.meshId)!.vertices,target=sample.meshes.find(m=>m.meshId===source.meshId)!.vertices;
   const region:Box={x0:Infinity,y0:Infinity,x1:-Infinity,y1:-Infinity};
   const indices=anchor.vertices.map(v=>anchor.source.meshVertexIndices[v]);
   const maxMotion=Math.max(...indices.map(v=>Math.hypot(base.screenX[v]-target.screenX[v],base.screenY[v]-target.screenY[v])));
   for(const v of indices)if(maxMotion>neutral.viewport.width*.00005&&Math.hypot(base.screenX[v]-target.screenX[v],base.screenY[v]-target.screenY[v])>neutral.viewport.width*.00005){for(const p of [base,target]){region.x0=Math.min(region.x0,p.screenX[v]);region.y0=Math.min(region.y0,p.screenY[v]);region.x1=Math.max(region.x1,p.screenX[v]);region.y1=Math.max(region.y1,p.screenY[v]);}}
   const pad=Math.max(.5,h*.01);return{x0:region.x0-pad,y0:region.y0-pad,x1:region.x1+pad,y1:region.y1+pad};
  }).filter(r=>Number.isFinite(r.x0));
  const maxEyeY=Math.max(...textureRevealRegions.map(r=>r.y1));
  selected=selected.filter(i=>i===anchor||(i.box.y0+i.box.y1)/2<=maxEyeY);
  if(!selected.length){result.push(source);continue;}
  const headAttachment=Float32Array.from(source.meshVertexIndices,v=>headVertices?Number(headVertices.has(v)):Number(neutral.meshes.find(m=>m.meshId===source.meshId)!.vertices.screenY[v]<=maxEyeY));
  result.push({...source,textureCutoutRegions:textureRevealRegions,headAttachment});
  const compact=(groups:Island[],id:string,role?:'skin'|'feature'):DrawableDecomposition=>{
   const local=new Map<number,number>(),vertices:number[]=[];const triangles=groups.flatMap(i=>i.triangles).map(v=>{if(!local.has(v)){local.set(v,vertices.length);vertices.push(source.meshVertexIndices[v]);}return local.get(v)!;});
   return{...source,id,label:role?`${source.label} [surface ${id.split('-').at(-1)}]`:source.label,triangles:Uint32Array.from(triangles),meshVertexIndices:Uint32Array.from(vertices),vertexCount:vertices.length,triangleCount:triangles.length/3,facialRole:role,surfaceTexture:!!role,textureRevealRegions,surfaceSourceId:source.id,blinkSupport:groups.some(i=>i.moving>0)};
  };
  selected.forEach((island,index)=>result.push(compact([island],`${source.id}-surface-${index}`,island===anchor?'skin':'feature')));
 }
 for(const d of result){const headParts=bundle.parts.filter(p=>p.meshId===d.meshId&&p.headVertexIndices!==undefined);if(headParts.length){const vertices=new Set(headParts.flatMap(p=>p.headVertexIndices!));d.rollAttachment=Float32Array.from(d.meshVertexIndices,v=>Number(vertices.has(v)));}}
 return result;
}

/** Static occlusion stays intact outside blink support. Other head surfaces
 * are omitted from the occluder pass only where the eyelid must reveal paint. */
export function surfaceTextureParts(parts:ProjectionPartSource[],drawable:DrawableDecomposition,neutral:BakeSample,_scale:number):ProjectionPartSource[]{
 const regions=drawable.textureRevealRegions??[];
 const anchorBox=regions.length?{x0:Math.min(...regions.map(r=>r.x0)),y0:Math.min(...regions.map(r=>r.y0)),x1:Math.max(...regions.map(r=>r.x1)),y1:Math.max(...regions.map(r=>r.y1))}:null;
 const occluders=parts.map(part=>{
  const vertices=neutral.meshes.find(m=>m.meshId===part.mesh.uuid)?.vertices;
  const triangles=part.triangles.filter(t=>{
   if(!vertices||part.mesh.uuid!==drawable.meshId||!anchorBox)return true;
   const [a,b,c]=t.vertexIndices;const minX=Math.min(vertices.screenX[a],vertices.screenX[b],vertices.screenX[c]),maxX=Math.max(vertices.screenX[a],vertices.screenX[b],vertices.screenX[c]),minY=Math.min(vertices.screenY[a],vertices.screenY[b],vertices.screenY[c]),maxY=Math.max(vertices.screenY[a],vertices.screenY[b],vertices.screenY[c]);
   // Hair or large body triangles do not belong to blink support just because
   // their projected bounds cross an eye. Require actual blink deformation,
   // or compact interior geometry lying entirely inside a reveal window.
   return !drawable.textureRevealTriangleKeys?.has(t.vertexIndices.join(','))||!regions.some(r=>maxX>=r.x0&&minX<=r.x1&&maxY>=r.y0&&minY<=r.y1);
  });
  return{...part,leafId:`${part.leafId}::bake-occluder`,triangles,triangleCount:triangles.length};
 }).filter(p=>p.triangles.length);
 return[...selectDrawableParts(parts,drawable).map(p=>({...p,preserveSmallPaintRegions:true})),...occluders];
}

/** Render precisely this surface, even if a color leaf spans several surfaces. */
export function selectDrawableParts(parts:ProjectionPartSource[],drawable:DrawableDecomposition):ProjectionPartSource[]{
 const keys=new Set<string>();for(let i=0;i<drawable.triangles.length;i+=3)keys.add(Array.from(drawable.triangles.subarray(i,i+3),v=>drawable.meshVertexIndices[v]).join(','));
 return parts.filter(p=>drawable.leafIds.includes(p.leafId)).map(p=>{const triangles=p.triangles.filter(t=>keys.has(t.vertexIndices.join(',')));return{...p,triangles,triangleCount:triangles.length};}).filter(p=>p.triangles.length>0);
}
