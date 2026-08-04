# MMD Physics Notes

## Problem

The PMX model could play the VMD animation, but MMD physics did not start.

The model data itself was valid for physics:

- animation tracks were loaded correctly
- the PMX contained rigid bodies
- the PMX contained constraints

So the failure was not caused by missing MMD physics metadata in the model.

## Root Cause

The actual problem was Ammo initialization in the browser.

`MMDAnimationHelper` depends on `Ammo`, and this project initially tried to load `three/examples/jsm/libs/ammo.wasm.js` with ESM-style `import()`.

That file is not designed to behave like a normal ESM module in this setup. It is effectively a script-style loader that expects to initialize a global `Ammo` object and then load its companion `.wasm` file.

Because of that mismatch, physics setup failed before `MMDAnimationHelper` could create the runtime physics world.

There was also a resource-loading issue: the wasm file path must be resolved explicitly in the Vite build output. If that path is not provided correctly, Ammo may try to fetch the wrong resource.

## Solution

The working solution has two parts:

1. Load `ammo.wasm.js` as a script, not via ESM `import()`.
2. Provide the correct built URL for `ammo.wasm.wasm` through `locateFile`.

Implementation summary:

- `ammo.wasm.js` is loaded by dynamically injecting a `<script>` tag.
- `ammo.wasm.wasm` is imported with Vite `?url` so the final built asset URL is known.
- `globalThis.Ammo.locateFile` is set before Ammo initialization so the loader can resolve the wasm file correctly.
- After Ammo becomes available, `MMDAnimationHelper.add(mesh, { animation, physics: true })` succeeds and physics runs normally.

## Current Runtime Flow

1. Load the PMX model.
2. Load the VMD animation.
3. Finish the current mesh processing pipeline.
4. Initialize Ammo.
5. Attach the mesh to `MMDAnimationHelper` with physics enabled.

This order matters because physics should be attached after the mesh is in the form used by the app.

## Result

The model now:

- plays the VMD animation
- initializes MMD physics successfully
- runs inside the Vite browser environment with the packaged Ammo wasm asset
