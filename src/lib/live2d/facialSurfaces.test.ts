import {expect,it} from 'vitest';
import {decomposeDrawables} from './decomposition';
import {facialFixture} from './facialSurfaces.fixture';
import {buildEyeOcclusion} from './eyeOcclusion';
import {surfaceTextureParts} from './facialSurfaces';
import type {ProjectionPartSource} from '../modelParts';
import {buildEyeForeground} from './eyeForeground';

// A single unnamed material contains clothing, the eyelid and two eyes.
// The skin ring has a real opening; its upper edge closes during blink.


it('separates facial surfaces from a mixed material using blink geometry, regardless of labels',()=>{
 const drawables=decomposeDrawables(facialFixture());
 expect(drawables).toHaveLength(3);
 expect(drawables.find(d=>d.facialRole==='skin')?.vertexCount).toBe(8);
 expect(drawables.find(d=>d.facialRole==='feature')?.vertexCount).toBe(4);
 expect(drawables.find(d=>!d.facialRole)?.vertexCount).toBe(15);
 expect(drawables.find(d=>!d.facialRole)?.textureCutoutRegions?.length).toBeGreaterThan(0);
 expect(drawables.filter(d=>d.facialRole).every(d=>d.surfaceTexture)).toBe(true);
});

it('retains decomposition when no blink signal is available',()=>{
 const bundle=facialFixture();bundle.samples=bundle.samples.slice(0,1);
 expect(decomposeDrawables(bundle)).toHaveLength(1);
});

it('does not attach body surfaces merely because they project into the face rectangle',()=>{
 const bundle=facialFixture();bundle.parts[0].headVertexIndices=Array.from({length:12},(_,i)=>i);
 for(const sample of bundle.samples){sample.meshes[0].vertices.screenX.set([40,60,50],12);sample.meshes[0].vertices.screenY.set([47,47,49],12);}
 const drawables=decomposeDrawables(bundle);
 expect(drawables.filter(d=>d.facialRole==='feature')).toHaveLength(1);
});

it('builds opaque geometric skin masks for surfaces occluded during blink without material names',()=>{
 const bundle=facialFixture(),drawables=decomposeDrawables(bundle);const result=buildEyeOcclusion(bundle,drawables);
 const eye=drawables.find(d=>d.facialRole==='feature')!;
 expect(result.maskers).toHaveLength(1);
 expect(result.targets.get(eye.id)).toEqual([result.maskers[0].id]);
 expect(result.maskers[0].maskOnly).toBe(true);
 expect(result.maskers[0].meshVertexIndices).toEqual(drawables.find(d=>d.facialRole==='skin')!.meshVertexIndices);
});

it('retains occluders away from the moving eye region while rendering only the requested surface',()=>{
 const bundle=facialFixture(),d=decomposeDrawables(bundle).find(d=>d.facialRole==='skin')!;
 const source={leafId:'one',mesh:{uuid:'m'},label:'unnamed',triangleCount:bundle.parts[0].triangles.length,triangles:bundle.parts[0].triangles.map(vertexIndices=>({vertexIndices}))} as ProjectionPartSource;
 const parts=surfaceTextureParts([source],d,bundle.samples[0],1);
 expect(parts.some(p=>p.leafId.includes('occluder'))).toBe(true);
 expect(parts.filter(p=>p.leafId==='one').flatMap(p=>p.triangles)).toHaveLength(8);
 expect(parts.filter(p=>p.leafId.includes('occluder')).flatMap(p=>p.triangles).some(t=>t.vertexIndices.includes(12))).toBe(true);
});

it('splits head geometry before connected components when skin continues into the torso',()=>{
 const bundle=facialFixture();bundle.parts[0].headVertexIndices=Array.from({length:12},(_,i)=>i);bundle.parts[0].triangles.push([2,12,13]);bundle.parts[0].triangleCount++;
 const skin=decomposeDrawables(bundle).find(d=>d.facialRole==='skin')!;
 expect([...skin.meshVertexIndices].every(v=>v<12)).toBe(true);
});

it('keeps the old decomposition for an ambiguous connected body without head weights',()=>{
 const bundle=facialFixture();bundle.parts[0].triangles.push([2,12,13]);bundle.parts[0].triangleCount++;
 expect(decomposeDrawables(bundle).some(d=>d.facialRole==='skin')).toBe(false);
});

it('retains unrelated occluder triangles even if they share a color leaf and cross the eye rectangle',()=>{
 const bundle=facialFixture(),skin=decomposeDrawables(bundle).find(d=>d.facialRole==='skin')!;
 for(const sample of bundle.samples){sample.meshes[0].vertices.screenX.set([40,60,50],12);sample.meshes[0].vertices.screenY.set([0,0,100],12);}
 skin.textureRevealLeafIds=['one'];skin.textureRevealTriangleKeys=new Set(['0,5,1']);
 const source={leafId:'one',mesh:{uuid:'m'},label:'unnamed',triangleCount:bundle.parts[0].triangles.length,triangles:bundle.parts[0].triangles.map(vertexIndices=>({vertexIndices}))} as ProjectionPartSource;
 const parts=surfaceTextureParts([source],skin,bundle.samples[0],1);
 expect(parts.filter(p=>p.leafId.includes('occluder')).flatMap(p=>p.triangles).some(t=>t.vertexIndices.includes(12))).toBe(true);
});

it('restores a static foreground patch even when hair and eyes share one material',()=>{
 const bundle=facialFixture();bundle.parts[0].headVertexIndices=Array.from({length:12},(_,i)=>i);
 for(const sample of bundle.samples){sample.meshes[0].vertices.screenX.set([40,60,50],12);sample.meshes[0].vertices.screenY.set([0,0,100],12);sample.meshes[0].vertices.depth.set([.05,.05,.05],12);}
 const drawables=decomposeDrawables(bundle),layers=buildEyeForeground(bundle,drawables);
 expect(layers).toHaveLength(1);
 expect(layers[0].deformationSourceId).toBe(drawables.find(d=>!d.surfaceTexture)!.id);
 expect(layers[0].textureCoverage![50*300+50]).toBe(1);
 expect(layers[0].textureCoverage![0]).toBe(0);
 expect([...layers[0].meshVertexIndices].sort()).toEqual([12,13,14]);
});
it('renders a separate head-bound foreground layer once above the facial patches',()=>{
 const bundle=facialFixture();bundle.parts[0].headVertexIndices=Array.from({length:12},(_,i)=>i);
 for(const sample of bundle.samples){sample.meshes[0].vertices.screenX.set([40,60,50],12);sample.meshes[0].vertices.screenY.set([0,0,100],12);sample.meshes[0].vertices.depth.set([.05,.05,.05],12);}
 const surfaces=decomposeDrawables(bundle).filter(d=>d.surfaceTexture);
 const front={id:'arbitrary-front',label:'arbitrary-17',meshId:'m',leafIds:['separate'],triangles:Uint32Array.from([0,2,1]),meshVertexIndices:Uint32Array.from([12,13,14]),vertexCount:3,triangleCount:1,rollAttachment:Float32Array.from([1,1,1])};
 const layers=buildEyeForeground(bundle,[...surfaces,front]);
 expect(layers).toHaveLength(0);expect((front as typeof front&{facialForeground?:boolean}).facialForeground).toBe(true);
});
