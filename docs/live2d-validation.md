# Head and contour validation — 2026-09-08.1

## Implemented

- Four explicit X/Y corner samples supplement axial sweeps. The joint grid
  stores the difference between the observed face centre and the additive
  prediction, capped at 8% of face height. Face features share the correction;
  long hair tips fade out. This is a translation correction, not a complete
  facial deformer or multi-view texture reconstruction.
- Preview, custom ZIP import/export, canvas framing and moc3 export all consume
  the joint grid. Export reserves both parameters even for joint-only motion.
- Disconnected hair topology is split into independent drawables when there
  are 2–8 substantial islands. Connected roots and highly fragmented topology
  remain unchanged. This does not yet infer semantic left/right/front layers.
- Mouth masks resolve actual drawable IDs in the same source mesh, survive
  ZIP roundtrips and use the same `maskIds` field throughout the pipeline.
  Stencil rendering preserves each target's own material and painter order.
- Small contour changes are smoothed after cyclic vertex correspondence.
  Different source parts cannot inherit one another's tracks. Holes, protected
  segments, changed vertex counts and large silhouette changes are excluded.

## Automated checks

`npm test` includes a real Cubism Core 5.1 fixture: export a model with motion
only in the joint grid, then compare all vertices with the preview evaluator
at 25 combinations of X/Y (-30, -15, 0, 15, 30). This checks binding, tensor
axis order and interpolation; it does not prove the real character looks good.

Other regressions cover sample counts, bounded face correction, canvas bounds,
ZIP mask/grid preservation, hair triangle conservation, stencil material and
scene ownership, and contour identity/jitter.

## Real-character acceptance still required

1. Rebuild the character with this pipeline. Old moc3 files do not gain the new
   geometry or joint grid. The preview should report one joint grid when a
   face and both head parameters resolve.
2. Use the nine pose buttons; compare neutral, axes and all four corners.
   Confirm the character's intended bangs remain, with no extra hair crossing,
   torn roots, eye/mouth distortion, neck gaps or canvas clipping.
3. Test blinks and mouth opening at the corners. A thin lip-line texture may
   not describe the entire mouth aperture; check visible mouth contents before
   accepting masking as visually correct.
4. Sweep continuously between poses in preview and in VTube Studio using a
   newly exported moc3. Check for jumps and compare with the same 3D poses.
5. For live stylized 2D, enable animation-stable tracking and inspect slow
   rotations. Verify small contours settle without seams, holes or lagging
   facial features.

Browser visual verification was not completed in this run: Computer Use stopped
because it could not identify the browser URL reliably. No screenshot or
VTube Studio acceptance is claimed by the automated checks.
