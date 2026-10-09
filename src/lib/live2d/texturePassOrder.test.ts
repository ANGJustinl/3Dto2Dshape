import {expect,it} from 'vitest';
import {texturePassOrder} from './build';
import type {DrawableDecomposition} from './decomposition';
it('finishes cached scene textures before isolated eye passes overwrite the shared GPU depth atlas',()=>{
 const input=[{id:'base-a'},{id:'eye',surfaceTexture:true},{id:'base-c'}] as DrawableDecomposition[];
 expect(texturePassOrder(input).map(d=>d.id)).toEqual(['base-a','base-c','eye']);
 expect(input.map(d=>d.id)).toEqual(['base-a','eye','base-c']);
});
