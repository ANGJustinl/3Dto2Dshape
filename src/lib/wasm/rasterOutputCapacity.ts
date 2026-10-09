type OutputCall = (pointer: number, capacity: number) => number;
type Allocator = { _malloc(size: number): number; _free(pointer: number): void };

/** The legacy size query performs the entire raster/contour computation. Skip it when capacity is known. */
export class RasterOutputCapacity {
    private capacity = 0;
    execute(allocator: Allocator, call: OutputCall, reuse: boolean) {
        let pointer = 0, queryMs = 0, writeMs = 0, retries = 0;
        const query = () => {
            const start = performance.now(), size = call(0, 0);
            queryMs += performance.now() - start;
            if (!Number.isInteger(size) || size <= 0 || size > 0x7fffffff) throw new Error(`Invalid WASM output size ${size}.`);
            return reuse ? Math.min(0x7fffffff, Math.ceil(size * 1.5)) : size;
        };
        let capacity = reuse && this.capacity > 0 ? this.capacity : query();
        try {
            pointer = allocator._malloc(capacity);
            if (!pointer) throw new Error('WASM output allocation failed.');
            const write = () => { const start = performance.now(), size = call(pointer, capacity); writeMs += performance.now() - start; return size; };
            let written = write();
            if (written === -4 && reuse) {
                allocator._free(pointer); pointer = 0;
                capacity = query(); retries += 1;
                pointer = allocator._malloc(capacity);
                if (!pointer) throw new Error('WASM output allocation failed.');
                written = write();
            }
            if (!Number.isInteger(written) || written <= 0 || written > capacity) throw new Error(`WASM returned invalid output size ${written}.`);
            if (reuse) this.capacity = capacity;
            return { pointer, written, capacity, queryMs, writeMs, retries };
        } catch (error) {
            if (pointer) allocator._free(pointer);
            throw error;
        }
    }
}
