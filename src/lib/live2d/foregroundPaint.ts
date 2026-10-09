import type {Live2dDrawable} from './model';
import type {DrawableDecomposition} from './decomposition';
/** Cover the same two-texel bleed as facial textures. Never erase source paint:
 * projected UVs can be shared by other hair triangles hidden in neutral pose. */
export function extendForegroundPaint(drawables:Live2dDrawable[],parts:Array<Pick<DrawableDecomposition,'id'|'foregroundOnly'|'deformationSourceId'>>):void{
 for(const part of parts.filter(p=>p.foregroundOnly)){
  const source=drawables.find(d=>d.id===part.deformationSourceId),foreground=drawables.find(d=>d.id===part.id);
  if(!source||!foreground)throw new Error('Missing foreground paint source');
  const shared=source.meshVertexIndices.indexOf(foreground.meshVertexIndices[0]);if(shared<0)throw new Error('Missing foreground paint source vertex');
  // Both UV tables come from the same neutral projection. Crop origins differ
  // by an integer number of texels, independent of viewport framing.
  const dx=Math.round(source.uvs[shared*2]*source.texture.width-foreground.uvs[0]*foreground.texture.width);
  const dy=Math.round(source.uvs[shared*2+1]*source.texture.height-foreground.uvs[1]*foreground.texture.height);
  const coverage=Uint8Array.from({length:foreground.texture.width*foreground.texture.height},(_,i)=>foreground.texture.rgba[i*4+3]);
  for(let y=0;y<foreground.texture.height;y++)for(let x=0;x<foreground.texture.width;x++){
   if(coverage[y*foreground.texture.width+x])continue;
   let nearby=false;
   for(let oy=-2;oy<=2&&!nearby;oy++)for(let ox=-2;ox<=2;ox++){
    const fx=x+ox,fy=y+oy;
    if(fx>=0&&fy>=0&&fx<foreground.texture.width&&fy<foreground.texture.height&&coverage[fy*foreground.texture.width+fx]===255){nearby=true;break;}
   }
   if(!nearby)continue;
   const sx=x+dx,sy=y+dy;if(sx<0||sy<0||sx>=source.texture.width||sy>=source.texture.height)continue;
   const p=(sy*source.texture.width+sx)*4;
   // Do not dilate natural translucent contours, only opaque backing paint.
   if(source.texture.rgba[p+3]===255)foreground.texture.rgba.set(source.texture.rgba.subarray(p,p+4),(y*foreground.texture.width+x)*4);
  }
 }
}
