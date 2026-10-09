import {expect,it} from 'vitest';
import {stabilizeHeadAngleKeyforms} from './headStabilization';
import {buildHeadExpressionJoints} from './headExpressionJoints';
import {createPoseEvaluator,type FamilyKeyforms} from './keyforms';
import type {DrawableDecomposition} from './decomposition';
import {defaultAssignment} from './paramMapping';

it('rotates blink displacement with the head instead of leaving it on the screen Y axis',()=>{
 const d={id:'a',label:'unknown',meshId:'m',leafIds:[],vertexCount:4,triangleCount:2,triangles:Uint32Array.from([0,1,2,0,2,3]),meshVertexIndices:Uint32Array.from([0,1,2,3]),facialRole:'skin' as const} as DrawableDecomposition;
 const neutral=[Float32Array.from([-1,-1,1,-1,1,1,-1,1])];
 const raw:Record<string,FamilyKeyforms>={ParamAngleZ:{family:'ParamAngleZ',default:0,values:[-30,0,30],displacements:[-30,0,30].map(deg=>Float32Array.from(Array.from(neutral[0],(_,i)=>{const p=Math.floor(i/2)*2,x=neutral[0][p],y=neutral[0][p+1],c=Math.cos(deg*Math.PI/180),s=Math.sin(deg*Math.PI/180);return i%2?s*x+c*y-y:c*x-s*y-x;})))},ParamEyeLOpen:{family:'ParamEyeLOpen',default:1,values:[0,.5,1],displacements:[1,.5,0].map(v=>Float32Array.from([0,v,0,v,0,0,0,0]))}};
 const families=stabilizeHeadAngleKeyforms([d],neutral,raw),joints=buildHeadExpressionJoints([d],neutral,families);
 const evaluator=createPoseEvaluator([d],neutral,families,joints),out=[new Float32Array(8)];
 evaluator.evaluate({...defaultAssignment(),ParamAngleZ:30,ParamEyeLOpen:0},out);
 expect(out[0][0]).toBeCloseTo(-Math.cos(Math.PI/6),5);
 expect(out[0][1]).toBeCloseTo(-Math.sin(Math.PI/6),5);
 // Linear native interpolation and preview agree at intermediate angles.
 evaluator.evaluate({...defaultAssignment(),ParamAngleZ:10,ParamEyeLOpen:0},out);
 expect(out[0][0]).toBeCloseTo(-(2+Math.cos(Math.PI/6))/3,5);
 expect(out[0][1]).toBeCloseTo(-Math.sin(Math.PI/6)/3,5);
});
