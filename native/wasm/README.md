# Raster contour WASM

The repository includes matching C++ source and generated runtime files:

- `native/wasm/raster_contour.cpp` / `.h`
- `public/wasm/raster_contour.js` / `.wasm`

Normal web usage and `npm run build` do not require Emscripten. After changing
C++ code, install and activate an Emscripten SDK, then regenerate both outputs:

```powershell
./tools/wasm/build.ps1
```

Commit the source and both generated files together. The browser offers `auto`,
`wasm` and TypeScript raster backends in Advanced settings. Initialization and
output capacity failures are reported explicitly rather than waiting forever.
