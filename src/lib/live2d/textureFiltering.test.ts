import {expect,it} from 'vitest';
import {linearPremultipliedPixels} from './textureFiltering';
it('keeps an opaque skin color when interpolating towards transparent pixels',()=>{
 const pixels=linearPremultipliedPixels(Uint8Array.from([255,128,64,255,0,0,0,0]));
 const alpha=(pixels[3]+pixels[7])/2;
 for(let c=0;c<3;c++)expect((pixels[c]+pixels[4+c])/2/alpha).toBeCloseTo(pixels[c],7);
 expect(alpha).toBe(.5);
});
