import {expect,it} from 'vitest';
import {copySourceDeformation} from './sourceDeformation';
import type {DrawableDecomposition} from './decomposition';
import type {FamilyKeyforms,JointKeyforms} from './keyforms';
it('copies source motion by mesh vertex identity for foreground paint and joint residuals',()=>{
 const source={id:'original',vertexCount:3,meshVertexIndices:Uint32Array.from([10,20,30])} as DrawableDecomposition;
 const target={id:'foreground',deformationSourceId:'original',vertexCount:2,meshVertexIndices:Uint32Array.from([30,10])} as DrawableDecomposition;
 const block=()=>Float32Array.from([1,2,3,4,5,6,99,99,99,99]);
 const family={family:'ParamAngleX',default:0,values:[0],displacements:[block()]} as FamilyKeyforms;
 const joint={x:{family:'ParamAngleX',default:0,values:[0]},y:{family:'ParamAngleY',default:0,values:[0]},displacements:[block()]} as JointKeyforms;
 copySourceDeformation([source,target],{ParamAngleX:family},[joint]);
 expect([...family.displacements[0].slice(6)]).toEqual([5,6,1,2]);
 expect([...joint.displacements[0].slice(6)]).toEqual([5,6,1,2]);
});
