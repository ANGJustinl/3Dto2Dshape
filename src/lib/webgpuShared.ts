type GPUAdapterLike = any;
type GPUDeviceLike = any;

class SharedWebGpuContext {
    private adapterPromise: Promise<GPUAdapterLike | null> | null = null;
    private devicePromise: Promise<GPUDeviceLike | null> | null = null;
    private device: GPUDeviceLike | null = null;

    isSupported() {
        return typeof navigator !== 'undefined' && 'gpu' in navigator;
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
