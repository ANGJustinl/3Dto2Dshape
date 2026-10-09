import {expect,it} from 'vitest';
import {extendForegroundPaint} from './foregroundPaint';
import type {Live2dDrawable} from './model';
const fixture=(alpha=255)=>{
 const source={id:'base',meshVertexIndices:Uint32Array.from([10]),uvs:Float32Array.from([.2,.2]),texture:{width:15,height:15,rgba:Uint8Array.from({length:15*15*4},(_,i)=>i%4===3?alpha:100)}} as Live2dDrawable;
 const foreground={id:'front',meshVertexIndices:Uint32Array.from([10]),uvs:Float32Array.from([0,0]),texture:{width:9,height:9,rgba:new Uint8Array(9*9*4)}} as Live2dDrawable;
 foreground.texture.rgba.set([100,100,100,alpha],(4*9+4)*4);
 return{source,foreground};
};
it('extends opaque foreground backing across the facial patch bleed without erasing shared source paint',()=>{
 const {source,foreground}=fixture(),original=source.texture.rgba.slice();
 extendForegroundPaint([source,foreground],[{id:'front',foregroundOnly:true,deformationSourceId:'base'}]);
 expect(source.texture.rgba).toEqual(original);
 expect(foreground.texture.rgba[(2*9+2)*4+3]).toBe(255);
 expect(foreground.texture.rgba[(1*9+1)*4+3]).toBe(0);
});
it('does not spread translucent contour paint into the boundary overlap',()=>{
 const {source,foreground}=fixture(128),original=source.texture.rgba.slice();
 extendForegroundPaint([source,foreground],[{id:'front',foregroundOnly:true,deformationSourceId:'base'}]);
 expect(source.texture.rgba).toEqual(original);
 expect(foreground.texture.rgba[(4*9+4)*4+3]).toBe(128);
 expect(foreground.texture.rgba[(4*9+3)*4+3]).toBe(0);
});
it('does not turn a translucent foreground contour into opaque paint over an opaque source',()=>{
 const {source,foreground}=fixture();
 foreground.texture.rgba[(4*9+4)*4+3]=128;
 extendForegroundPaint([source,foreground],[{id:'front',foregroundOnly:true,deformationSourceId:'base'}]);
 expect(foreground.texture.rgba[(4*9+4)*4+3]).toBe(128);
 expect(foreground.texture.rgba[(4*9+3)*4+3]).toBe(0);
});
