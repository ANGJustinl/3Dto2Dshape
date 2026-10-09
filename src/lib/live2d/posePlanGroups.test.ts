import {expect,it} from 'vitest';
import {groupPosePlans} from './posePlanGroups';
import {defaultAssignment} from './paramMapping';
it('evaluates a shared pose once while retaining all native keyform destinations',()=>{
 const a=defaultAssignment(),b={...a,ParamAngleX:30};
 const groups=groupPosePlans([{drawableIndex:0,keyformAssignments:[a,b]},{drawableIndex:1,keyformAssignments:[a,b]}],['ParamAngleX']);
 expect(groups).toHaveLength(2);expect(groups[0].references).toEqual([{drawableIndex:0,key:0},{drawableIndex:1,key:0}]);
});
it('does not merge distinct small parameter values',()=>{
 const groups=groupPosePlans([{drawableIndex:0,keyformAssignments:[{...defaultAssignment(),ParamAngleX:.00001},{...defaultAssignment(),ParamAngleX:.00002}]}],['ParamAngleX']);
 expect(groups).toHaveLength(2);
});
