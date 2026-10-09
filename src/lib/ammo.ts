import ammoWasmScriptUrl from 'three/examples/jsm/libs/ammo.wasm.js?url';
import ammoWasmUrl from 'three/examples/jsm/libs/ammo.wasm.wasm?url';

/**
 * Loads the Ammo physics runtime used by MMDAnimationHelper. The wasm build
 * is a classic script that installs a global factory, so it cannot be
 * imported as an ES module; it is injected once and memoized.
 */
let ammoPromise: Promise<unknown> | null = null;

export const ensureAmmo = async () => {
    const globalObject = globalThis as typeof globalThis & { Ammo?: unknown };
    if (ammoPromise) {
        return ammoPromise;
    }

    if (typeof (globalObject.Ammo as { btTransform?: unknown } | undefined)?.btTransform === 'function') {
        return globalObject.Ammo;
    }

    ammoPromise = new Promise<unknown>((resolve, reject) => {
        const existingScript = document.querySelector<HTMLScriptElement>(
            `script[data-ammo-loader="true"]`,
        );

        globalObject.Ammo = {
            locateFile: (path: string) => (path.endsWith('.wasm') ? ammoWasmUrl : path),
        };

        const finalize = async () => {
            try {
                const ammoFactory = globalObject.Ammo as
                    | ((config?: { locateFile?: (path: string) => string }) => Promise<unknown>)
                    | { ready?: Promise<unknown> };

                if (typeof ammoFactory === 'function') {
                    const ammo = await ammoFactory({
                        locateFile: (path: string) => (path.endsWith('.wasm') ? ammoWasmUrl : path),
                    });
                    globalObject.Ammo = ammo;
                    resolve(ammo);
                    return;
                }

                if (ammoFactory && typeof ammoFactory === 'object' && ammoFactory.ready) {
                    const ammo = await ammoFactory.ready;
                    globalObject.Ammo = ammo;
                    resolve(ammo);
                    return;
                }

                reject(new Error('Ammo factory did not initialize.'));
            } catch (error) {
                reject(error);
            }
        };

        if (existingScript) {
            void finalize();
            return;
        }

        const script = document.createElement('script');
        script.src = ammoWasmScriptUrl;
        script.async = true;
        script.dataset.ammoLoader = 'true';
        script.onload = () => {
            void finalize();
        };
        script.onerror = () => {
            ammoPromise = null;
            reject(new Error('Failed to load ammo.wasm.js script.'));
        };
        document.head.appendChild(script);
    });

    try {
        return await ammoPromise;
    } catch (error) {
        ammoPromise = null;
        delete globalObject.Ammo;
        document.querySelector('script[data-ammo-loader="true"]')?.remove();
        throw error;
    }
};
