import type {ProjectedPartShape} from '../2DRenderShared/types';
/** Render the scene in its original order: white is selected paint, black
 * is occlusion. An opaque later surface erases paint; exact depth ties keep
 * the same winning surface as the full scene. */
export const paintVisibilityMask=(scene:ProjectedPartShape[],leaves:ReadonlySet<string>)=>scene.map(shape=>({
 ...shape,color:leaves.has(shape.sourceLeafId)?'#FFFFFF':'#000000',
 opacity:leaves.has(shape.sourceLeafId)?1:shape.opacity,previewFlatInk:false,
}));
