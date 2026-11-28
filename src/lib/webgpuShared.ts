type GPUAdapterLike = any;
type GPUDeviceLike = any;

class SharedWebGpuContext {
    private adapterPromise: Promise<GPUAdapterLike | null> | null = null;
    private devicePromise: Promise<GPUDeviceLike | null> | null = null;
    private device: GPUDeviceLike | null = null;
    private generation = 0;

    isSupported() {
        return typeof navigator !== 'undefined' && 'gpu' in navigator;
    }

    /** [device recovery] bump when the device is lost so consumers rebuild GPU resources. */
    getGeneration() {
        return this.generation;
    }

    private invalidate(device: GPUDeviceLike) {
        if (this.device !== device) return;
        this.device = null;
        this.devicePromise = null;
        this.adapterPromise = null;
        this.generation += 1;
        console.warn('[WEBGPU_INVALIDATED]', JSON.stringify({ generation: this.generation, t: Date.now() }));
    }

    /** [device recovery] force-rotate the device after a lost-related failure. */
    invalidateForRetry() {
        if (!this.device) return;
        try { this.device.destroy?.(); } catch { /* ignore */ }
        this.device = null;
        this.devicePromise = null;
        this.adapterPromise = null;
        this.generation += 1;
        console.warn('[WEBGPU_RETRY_ROTATE]', JSON.stringify({ generation: this.generation, t: Date.now() }));
    }

    async getDevice() {
        if (this.device) {
            return this.device;
        }

        if (!this.adapterPromise) {
            this.adapterPromise = (async () => {
                const gpuNavigator = navigator as Navigator & {
                    gpu?: { requestAdapter?: () => Promise<GPUAdapterLike | null> };
                };
                return (await gpuNavigator.gpu?.requestAdapter?.()) ?? null;
            })();
        }

        if (!this.devicePromise) {
            this.devicePromise = (async () => {
                const adapter = await this.adapterPromise;
                if (!adapter) {
                    return null;
                }
                // Close-up views pack large part rasters into the depth atlas;
                // ask for the adapter's real 2D texture limit (often 16384)
                // instead of the 8192 default.
                const device = await adapter.requestDevice({
                    requiredLimits: { maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
                });
                this.device = device;
                // [device recovery] on loss, drop all cached handles so the next
                // getDevice() requests a fresh adapter/device in this page.
                device.lost?.then?.((info: any) => {
                    console.warn('[WEBGPU_DEVICE_LOST]', JSON.stringify({ reason: info?.reason, message: info?.message, t: Date.now() }));
                    this.invalidate(device);
                });
                console.log('[WEBGPU_DEVICE_CREATED]', JSON.stringify({ generation: this.generation, maxTex2D: device.limits?.maxTextureDimension2D, t: Date.now() }));
                return device;
            })();
        }

        return this.devicePromise;
    }

    getPreferredCanvasFormat() {
        const gpuNavigator = navigator as Navigator & {
            gpu?: { getPreferredCanvasFormat?: () => string };
        };
        return gpuNavigator.gpu?.getPreferredCanvasFormat?.() ?? 'bgra8unorm';
    }
}

let sharedContext: SharedWebGpuContext | null = null;

export const getSharedWebGpuContext = () => {
    sharedContext ??= new SharedWebGpuContext();
    return sharedContext;
};
