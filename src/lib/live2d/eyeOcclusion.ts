import type {DrawableDecomposition} from './decomposition';
import type {BakeBundle,BakeSample} from './types';
import type {Live2dTexture} from './model';
export type OcclusionPaint={texture:Live2dTexture;cropX:number;cropY:number;scale:number};

/** Depth rasterization is confined to a candidate eye, not the whole body. */
function visibility(sample:BakeSample,skin:DrawableDecomposition,feature:DrawableDecomposition,paint?:OcclusionPaint,neutral?:BakeSample){
 const vertices=sample.meshes.find(m=>m.meshId===skin.meshId)?.vertices;if(!vertices)return{total:0,visible:0,valid:false};
 const ids=feature.meshVertexIndices;let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
 for(const v of ids){x0=Math.min(x0,vertices.screenX[v]);y0=Math.min(y0,vertices.screenY[v]);x1=Math.max(x1,vertices.screenX[v]);y1=Math.max(y1,vertices.screenY[v]);}
 const scale=4; x0=Math.floor(x0)-1;y0=Math.floor(y0)-1;
 const width=Math.ceil((x1-x0+1)*scale),height=Math.ceil((y1-y0+1)*scale);
 if(width<1||height<1||width*height>4_000_000)return{total:0,visible:0,valid:false};
 const skinDepth=new Float32Array(width*height).fill(Infinity),eyeDepth=new Float32Array(width*height).fill(Infinity),eyeAlpha=new Float32Array(width*height);
 const reference=neutral?.meshes.find(m=>m.meshId===feature.meshId)?.vertices;
 const raster=(d:DrawableDecomposition,out:Float32Array)=>{
  for(let i=0;i<d.triangles.length;i+=3){const [a,b,c]=Array.from(d.triangles.subarray(i,i+3),v=>d.meshVertexIndices[v]);
   const ax=(vertices.screenX[a]-x0)*scale,ay=(vertices.screenY[a]-y0)*scale,bx=(vertices.screenX[b]-x0)*scale,by=(vertices.screenY[b]-y0)*scale,cx=(vertices.screenX[c]-x0)*scale,cy=(vertices.screenY[c]-y0)*scale;
   // Eye paint is exported double sided; the skin mask is culled per pose.
   // Ignoring a back-facing eye here leaves visible white paint unmasked.
   const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);if(Math.abs(area)<1e-7||(d===skin&&area>=-1e-7))continue;
   for(let y=Math.max(0,Math.floor(Math.min(ay,by,cy)));y<Math.min(height,Math.ceil(Math.max(ay,by,cy)));y++)for(let x=Math.max(0,Math.floor(Math.min(ax,bx,cx)));x<Math.min(width,Math.ceil(Math.max(ax,bx,cx)));x++){
    const px=x+.5,py=y+.5;
    const u=((bx-px)*(cy-py)-(by-py)*(cx-px))/area,v=((cx-px)*(ay-py)-(cy-py)*(ax-px))/area,w=1-u-v;
    if(u<0||v<0||w<0)continue;const z=u*vertices.depth[a]+v*vertices.depth[b]+w*vertices.depth[c],p=y*width+x;
    let alpha=1;
    if(d===feature&&paint&&reference){
     const nx=u*reference.screenX[a]+v*reference.screenX[b]+w*reference.screenX[c],ny=u*reference.screenY[a]+v*reference.screenY[b]+w*reference.screenY[c];
     if(feature.textureRevealRegions?.length&&!feature.textureRevealRegions.some(r=>nx>=r.x0&&nx<=r.x1&&ny>=r.y0&&ny<=r.y1))continue;
     const tx=Math.floor(nx*paint.scale-paint.cropX),ty=Math.floor(ny*paint.scale-paint.cropY);
     alpha=tx>=0&&ty>=0&&tx<paint.texture.width&&ty<paint.texture.height?paint.texture.rgba[(ty*paint.texture.width+tx)*4+3]/255:0;
    }
    if(alpha<=0||z>out[p])continue;out[p]=z;if(d===feature)eyeAlpha[p]=alpha;
   }
  }
 };
 raster(skin,skinDepth);raster(feature,eyeDepth);let total=0,visible=0;
 for(let i=0;i<eyeDepth.length;i++)if(Number.isFinite(eyeDepth[i])){total+=eyeAlpha[i];if(eyeDepth[i]<=skinDepth[i]+1e-7)visible+=eyeAlpha[i];}
 return{total,visible,valid:true};
}

export function buildEyeOcclusion(bundle:BakeBundle,drawables:DrawableDecomposition[],paint?:Map<string,OcclusionPaint>){
 const maskers:DrawableDecomposition[]=[],targets=new Map<string,string[]>(),report:unknown[]=[];
 const neutral=bundle.samples.find(s=>s.kind==='neutral');if(!neutral)return{maskers,targets,report};
 const blinks=bundle.samples.filter(s=>(s.family==='ParamEyeLOpen'||s.family==='ParamEyeROpen')&&s.assignment[s.family]===0);
 for(const skin of drawables.filter(d=>d.facialRole==='skin')){
  const candidates=drawables.filter(d=>d.meshId===skin.meshId&&d.facialRole==='feature');
  for(const feature of candidates){
   const featurePaint=paint?.get(feature.id);
   const open=visibility(neutral,skin,feature,featurePaint,neutral);if(open.total<4||(!featurePaint&&open.visible<4))continue;
   const closes=blinks.map(sample=>({family:sample.family,...visibility(sample,skin,feature,paint?.get(feature.id),neutral)}));
   // A surface hidden even at neutral still needs clipping in a flat export.
   // Filtering it by visible area leaves a white rim when depth is removed.
   const occluded=(!!featurePaint&&open.visible/open.total<.2)||closes.some(c=>c.valid&&(c.total===0||c.visible/c.total<(open.visible/open.total)*.2));
   report.push({id:feature.id,label:feature.label,open,closes,occluded});
   if(!occluded)continue;
   let mask=maskers.find(d=>d.id===`${skin.id}-occlusion`);
   if(!mask){
    // The renderer culls the back side at each pose. Neutral-only pruning
    // loses eyelid triangles that turn towards the viewer during closure.
    mask={...skin,id:`${skin.id}-occlusion`,label:'Eye occlusion surface',facialRole:'feature',maskOnly:true,triangles:skin.triangles.slice(),triangleCount:skin.triangleCount};maskers.push(mask);
   }
   targets.set(feature.id,[mask.id]);
  }
 }
 return{maskers,targets,report};
}
