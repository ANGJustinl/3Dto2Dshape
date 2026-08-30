// Dev tool: validates .moc3 files against the REAL Cubism Core (the Web
// build from Live2D's CDN), which is the same parsing/validation path
// VTube Studio's native core uses. Usage:
//   node scripts/verify-moc3.mjs <core.js> <file.moc3> [more.moc3 ...]
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const corePath = process.argv[2];
const files = process.argv.slice(3);

const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    atob: (text) => Buffer.from(text, 'base64').toString('binary'),
    btoa: (text) => Buffer.from(text, 'binary').toString('base64'),
    TextDecoder,
    TextEncoder,
    self: null,
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.document = { currentScript: null };
sandbox.location = { href: 'file:///' };
vm.createContext(sandbox);
vm.runInContext(readFileSync(corePath, 'utf8'), sandbox);
const core = sandbox.Live2DCubismCore ?? sandbox.module?.exports;
if (!core) {
    throw new Error('Core did not expose Live2DCubismCore.');
}

// The core compiles its WASM asynchronously; wait until it reports ready.
const ready = () =>
    typeof core.isReady === 'function' ? core.isReady() : typeof core.csmGetVersion === 'function';
for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!ready() && typeof core.then === 'function') {
    await core.then;
}
console.log(`core ready: ${ready()}`);

for (const file of files) {
    const bytes = readFileSync(file);
    console.log(`\n== ${file} (${bytes.length} bytes) ==`);
    try {
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const moc = core.Moc.fromArrayBuffer(buffer);
        console.log('Moc.fromArrayBuffer: OK');
        const model = core.Model.fromMoc(moc);
        console.log('Model.fromMoc: OK');
        console.log(
            `drawables: ${model.drawables.count}, params: ${model.parameters.count}, parts: ${model.parts.count}`,
        );
        console.log('first drawable ids:', model.drawables.ids.slice(0, 4));
        console.log('param ids:', model.parameters.ids.slice(0, 8));
        model.release();
        try {
            moc.release();
        } catch {
            // older core builds expose _release only
        }
    } catch (error) {
        console.log(`FAILED: ${error.message ?? error}`);
    }
}
