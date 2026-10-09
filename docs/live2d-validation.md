# Live2D rendering and export repairs

## Current implementation

The shared pipeline is `2026-10-09.23`. New model bakes incorporate the accepted
face, eye, hair and head/neck repairs; previously saved ZIP/moc3 files must be
rebuilt to acquire them.

- Material visibility, authored normals, stable opaque fills and depth masking
  are shared by the live 2D view and isolated texture capture. Hidden material
  surfaces are not promoted into visible paint.
- Facial surfaces keep skin, eyelids, eye contents and clipping masks together.
  Eye foreground retention and alpha-correct texture filtering reduce separated
  eyelids and dark fringes. Mask-only drawables retain their clipping role.
- The head rig is derived from source skeleton joints and projected surface
  bounds. Head pivot and neck-base weights are preserved through expressions,
  project serialization, preview evaluation and native ArtMesh export.
- Native export samples the same pose evaluator as preview, groups compatible
  parameter plans and retains mask IDs and drawable visibility.
- The motion parser uses official Cubism segment codes by default. The legacy
  1..4 encoding is accepted only when its interpretation is unambiguous.

These repairs are based on model structure rather than a character-name branch.
Bone and morph resolution is still heuristic; unsupported models can lack
parameters or require manual changes.

## Scope of prior acceptance

Earlier experiment and production rounds checked Amiya and Corin, then other
previously imported characters, including Mika. Checks covered neutral poses,
left/right turns, blinks, eye clipping, hair paint and fixed neck anchors.
Custom ZIP and official Core rendering were compared in those earlier runs.

This release carries the shared implementation, not the private model assets,
render captures or proprietary Core runtime. Prior character checks do not
establish compatibility with every model or every version of VTube Studio.

## Inspecting a new model

1. Import the complete model folder and bake it again. Check the resolved and
   missing parameter list in the bake summary.
2. Inspect neutral, left/right and combined poses, starting around ±15°.
3. Blink and open the mouth at those poses. Inspect eyelid/skin boundaries,
   preserved bangs, hair color and neck attachment.
4. Export the project ZIP, reopen it and compare the same poses. Export a new
   native archive separately and inspect it in the intended Live2D runtime.
5. In VTube Studio, configure tracking parameters and assess continuous motion.
   SDK rendering alone is not acceptance of a real camera-tracking session.

Existing regression sources cover geometry, masks, serialization, motion
parsing and native keyforms. Optional official Core fixture checks require the
separately acquired Core runtime described in `public/preview/README.txt`.
