import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VisibleRegionState, isProtectedPaintDetail } from './visibleRegions';
import { TemporalPaintState, FLICKER_PRESETS } from './temporalPaint';
import { createDefaultProjectionSettings } from '../2DRenderShared/defaultSettings';
import { buildProjectedPartShapeFromRasterData } from '../2DRenderStages/partShaping/partAssembler';
import { filterSmallProjectedPartShapes } from '../2DRenderShared/filters';
import type { RasterizedPartData } from '../2DRenderStages/partRasterization/rasterizer';
import type { MeshProjectionCache } from '../2DRenderShared/types';
import type { ProjectionPartSource } from '../modelParts';

const source: ProjectionPartSource = { leafId: 'cloth', label: 'cloth', materialNames: ['cloth'], parentPath: '', mesh: new THREE.Mesh(), triangleCount: 1, color: '#808080', triangles: [{ vertexIndices: [0,1,2], vertexPositionKeys: ['a','b','c'] }] };
const cache = (shift = 0): MeshProjectionCache => ({ width: 100, height: 100, screenX: new Float32Array([shift, shift+10, shift]), screenY: new Float32Array([0,0,10]), depth: new Float32Array([.5,.5,.5]), worldX: new Float32Array([0,1,0]), worldY: new Float32Array([0,0,1]), worldZ: new Float32Array(3) });
const raster = (w: number, h: number, shift = 0): RasterizedPartData => ({ width: w, height: h, occupied: new Uint8Array(w*h).fill(1), depth: new Float32Array(w*h).fill(.5), loops: [[{x:shift,y:0},{x:shift+w,y:0},{x:shift+w,y:h},{x:shift,y:h}]], offsetX:shift,offsetY:0,nearestDepth:.5,atlasX:0,atlasY:0,atlasWidth:w,atlasHeight:h,orientedBounds:{center:{x:w/2,y:h/2},width:w,height:h,angle:0,corners:[]} } as unknown as RasterizedPartData);
const occupied = (item: RasterizedPartData | null) => item?.occupied.reduce((sum,value)=>sum+value,0) ?? 0;

describe('visible shade region experiment', () => {
    it('splits current visible pixels into retained shade and base fill without holes', () => {
        const state = new VisibleRegionState(), input = raster(2,2);
        const result = state.process(source,'shadow',input,cache(),16,.35);
        expect(occupied(result.kept)).toBe(0); expect(occupied(result.merged)).toBe(4);
        expect(occupied(input)).toBe(4); expect(result.kept.loops).toBeUndefined();
        expect(result.merged?.depth).toBe(input.depth);
    });
    it('uses distinct thresholds for entering and leaving a visible shade', () => {
        const state = new VisibleRegionState();
        expect(occupied(state.process(source,'shadow',raster(4,4),cache(),16,.35).kept)).toBe(0);
        expect(occupied(state.process(source,'shadow',raster(5,5),cache(),16,.35).kept)).toBe(25);
        expect(occupied(state.process(source,'shadow',raster(4,4),cache(),16,.35).kept)).toBe(16);
        expect(occupied(state.process(source,'shadow',raster(3,3),cache(),16,.35).kept)).toBe(0);
    });
    it('follows part translation while keeping fill geometry in the current frame', () => {
        const state = new VisibleRegionState(); state.process(source,'shadow',raster(5,5),cache(),16,.35);
        const result = state.process(source,'shadow',raster(4,4,30),cache(30),16,.35);
        expect(occupied(result.kept)).toBe(16); expect(result.kept.offsetX).toBe(30);
        const suppressed = state.process(source,'shadow',raster(2,3,30),cache(30),16,.35);
        expect(occupied(suppressed.merged)).toBe(6); expect(suppressed.merged?.offsetX).toBe(30);
    });
    it('does not match a different depth surface or a different source part', () => {
        const state = new VisibleRegionState(); state.process(source,'shadow',raster(5,5),cache(),16,.35);
        const otherDepth = raster(4,4); otherDepth.depth.fill(.7);
        expect(occupied(state.process(source,'shadow',otherDepth,cache(),16,.35).kept)).toBe(0);
        const other = { ...source, triangles: [...source.triangles] };
        expect(occupied(state.process(other,'shadow',raster(4,4),cache(),16,.35).kept)).toBe(0);
    });
    it('leaves holes and disjoint large regions intact', () => {
        const state = new VisibleRegionState(), input = raster(9,5); input.occupied.fill(0);
        for(let y=0;y<5;y++)for(let x=0;x<5;x++)input.occupied[y*9+x]=1;
        input.occupied[20]=0;
        input.occupied[8]=1; input.occupied[17]=1; input.occupied[26]=1;
        const result = state.process(source,'shadow',input,cache(),16,.35);
        expect(occupied(result.kept)).toBe(24); expect(occupied(result.merged)).toBe(3);
        for(let i=0;i<input.occupied.length;i++)expect(result.kept.occupied[i]+(result.merged?.occupied[i]??0)).toBe(input.occupied[i]);
    });
    it('clears visible-region history when seeking', () => {
        const state = new TemporalPaintState(), settings = {...createDefaultProjectionSettings(), flickerControl: FLICKER_PRESETS.visible};
        state.beginFrame(settings,1,100,100);state.visibleRegions.process(source,'shadow',raster(5,5),cache(),16,.35);
        state.beginFrame(settings,0,100,100);
        expect(occupied(state.visibleRegions.process(source,'shadow',raster(4,4),cache(),16,.35).kept)).toBe(0);
    });
    it('recognizes facial and accent details', () => {
        for(const label of ['eye','mouth','目影','瞳','眉'])expect(isProtectedPaintDetail({...source,label})).toBe(true);
        expect(isProtectedPaintDetail({...source,accentScore:.8})).toBe(true);
        expect(isProtectedPaintDetail(source)).toBe(false);
    });
    it('keeps a small base fill through both downstream area filters', () => {
        const settings = createDefaultProjectionSettings(), input = raster(2,2);
        const result = buildProjectedPartShapeFromRasterData({...source,paintLayer:'base',preserveSmallPaintRegions:true}, {sharedChains:[]}, cache(), settings, input);
        expect(result.shape?.area).toBe(4);
        expect(filterSmallProjectedPartShapes([result.shape!],24,{},false)).toHaveLength(1);
        expect(buildProjectedPartShapeFromRasterData(source,{sharedChains:[]},cache(),settings,input).shape).toBeNull();
    });
});
