/** Filter premultiplied linear colors, then unpremultiply in the shader.
 * Straight-alpha bilinear sampling blends transparent black into eyelids. */
export function linearPremultipliedPixels(rgba:Uint8Array):Float32Array{
 const result=new Float32Array(rgba.length);
 const linear=(v:number)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
 for(let i=0;i<rgba.length;i+=4){const alpha=rgba[i+3]/255;for(let c=0;c<3;c++)result[i+c]=linear(rgba[i+c]/255)*alpha;result[i+3]=alpha;}
 return result;
}
