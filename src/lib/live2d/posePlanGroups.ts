import type {ParamAssignment,FaceParamId} from './types';
export type PosePlan={drawableIndex:number;keyformAssignments:ParamAssignment[]};
export function groupPosePlans(plans:PosePlan[],ids:FaceParamId[]){
 const groups=new Map<string,{assignment:ParamAssignment;references:Array<{drawableIndex:number;key:number}>}>();
 for(const plan of plans)plan.keyformAssignments.forEach((assignment,key)=>{
  const identity=ids.map(id=>assignment[id]??0).join('/');
  const group=groups.get(identity)??{assignment,references:[]};group.references.push({drawableIndex:plan.drawableIndex,key});groups.set(identity,group);
 });
 return [...groups.values()];
}
