import { describe, expect, it } from 'vitest';
import { RasterOutputCapacity } from './rasterOutputCapacity';
const fixture = () => {
    let required = 20, pointer = 16;
    const allocations: number[] = [], frees: number[] = [], calls: Array<[number,number]> = [];
    const allocator = { _malloc: (size:number) => { allocations.push(size); return pointer++; }, _free: (value:number) => { frees.push(value); } };
    const call = (value:number,capacity:number) => { calls.push([value,capacity]);return value === 0 ? required : capacity >= required ? required : -4; };
    return {allocator,call,allocations,frees,calls,resize:(size:number)=>required=size};
};
describe('reuse WASM raster output capacity', () => {
    it('preserves the two-call protocol when the experiment is disabled', () => {
        const state=new RasterOutputCapacity(), f=fixture();state.execute(f.allocator,f.call,false);state.execute(f.allocator,f.call,false);
        expect(f.calls.filter(([pointer])=>pointer===0)).toHaveLength(2);expect(f.allocations).toEqual([20,20]);
    });
    it('skips the redundant full size calculation on subsequent frames', () => {
        const state=new RasterOutputCapacity(),f=fixture();const first=state.execute(f.allocator,f.call,true);f.allocator._free(first.pointer);
        const second=state.execute(f.allocator,f.call,true);f.allocator._free(second.pointer);
        expect(f.calls).toHaveLength(3);expect(first.written).toBe(second.written);expect(f.allocations).toEqual([30,30]);expect(f.frees).toHaveLength(2);
    });
    it('grows the buffer and retries safely after an insufficient-capacity result', () => {
        const state=new RasterOutputCapacity(),f=fixture();state.execute(f.allocator,f.call,true);f.resize(40);
        const result=state.execute(f.allocator,f.call,true);
        expect(result.written).toBe(40);expect(result.retries).toBe(1);expect(result.capacity).toBe(60);expect(f.frees).toHaveLength(1);
    });
    it('rejects invalid output and frees the allocation on failure', () => {
        const state=new RasterOutputCapacity(),f=fixture();
        expect(()=>state.execute(f.allocator,(pointer)=>pointer ? 100 : 20,false)).toThrow('invalid output size');expect(f.frees).toHaveLength(1);
        expect(()=>state.execute(f.allocator,()=>-5,true)).toThrow('Invalid WASM output size');
    });
});
