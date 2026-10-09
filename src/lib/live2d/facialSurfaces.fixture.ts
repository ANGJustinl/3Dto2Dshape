import type {BakeBundle,BakeSample} from './types';
export const facialFixture=():BakeBundle=>{
 const points=[[0,0],[100,0],[100,100],[0,100],[30,40],[70,40],[70,60],[30,60],
 [40,45],[60,45],[60,55],[40,55],[200,200],[250,200],[225,250]];
 const triangles:[[number,number,number],...[number,number,number][]]=[[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7],[8,9,10],[8,10,11],[12,13,14]];
 const make=(family?:'ParamEyeLOpen'|'ParamEyeROpen',open=1):BakeSample=>({id:family??'neutral',kind:family?'family-sweep':'neutral',family,index:0,viewport:{width:300,height:300},assignment:{ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0,ParamEyeLOpen:family==='ParamEyeLOpen'?open:1,ParamEyeROpen:family==='ParamEyeROpen'?open:1,ParamMouthOpenY:0},meshes:[{meshId:'m',vertices:{screenX:Float32Array.from(points.map(p=>p[0])),screenY:Float32Array.from(points.map((p,i)=>family==='ParamEyeLOpen'&&[4,5].includes(i)?40+20*(1-open):p[1])),depth:Float32Array.from(points.map((_,i)=>i<8?.1:.2))}}]});
 return{schemaVersion:1,createdAt:'',modelName:'arbitrary',params:[],parts:[{leafId:'one',meshId:'m',label:'material-42',color:'#abcdef',triangleCount:triangles.length,triangles:triangles.map(([a,b,c])=>[a,c,b])}],samples:[make(),make('ParamEyeLOpen',0),make('ParamEyeLOpen',1),make('ParamEyeROpen',0),make('ParamEyeROpen',1)]};
};
