# Raster contour WASM

Build with Emscripten:

```powershell
./tools/wasm/build.ps1
```

The repository currently keeps the C++ source and build script. The generated
`public/wasm/raster_contour.js` and `.wasm` files are produced only after an
Emscripten SDK is installed; the web app reports a clear initialization error
until those artifacts exist.
