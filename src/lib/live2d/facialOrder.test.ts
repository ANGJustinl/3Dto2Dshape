import {expect,it} from 'vitest';
import {enforceMouthOrder} from './mouthMasks';
it('orders all anatomical eye surfaces together, preserving iris in front of white and overriding legacy face labels',()=>{
 const parts=[{id:'original',label:'Face',meshId:'m'},{id:'skin',label:'material-42',meshId:'m',facialRole:'skin' as const},{id:'white',label:'material-99',meshId:'m',facialRole:'feature' as const},{id:'iris',label:'Eye',meshId:'m',facialRole:'feature' as const}];
 const order=enforceMouthOrder(parts,['original','skin','white','iris']);
 expect(order.indexOf('iris')).toBeGreaterThan(order.indexOf('white'));
 expect(order.indexOf('white')).toBeGreaterThan(order.indexOf('skin'));
});
