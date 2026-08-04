# Projection Mask Redesign

## Goal

The screen-space shape pipeline should not use one dense shared ID mask as the direct source of polygon contours.

The global ID pass is only reliable for visibility:

- which part is frontmost at each screen pixel
- which pixels of a part are actually visible in the current view

It is not reliable as the direct contour source for simplification, because adjacent parts tile the screen without gaps and later simplification can easily introduce visible cracks.

## Revised Model

The pipeline should be split into two layers.

### 1. Global ID Mask

One render pass for all parts together.

Purpose:

- frontmost-part visibility
- depth-tested ownership of each pixel
- final visible region of each part

This pass should **not** be used directly as the polygon contour source.

### 2. Per-Part Accumulation Mask

Each part builds its own mask separately.

While rasterizing triangles into this mask, each covered pixel is accumulated with `+1` instead of a binary fill.

So the mask contains values like:

- `0`: outside the part projection
- `1`: covered by one projected triangle layer
- `2`, `3`, ...: covered by multiple projected layers

This makes it possible to extract two different kinds of boundaries.

## Two Boundary Types

### A. Screen Contour

Boundary between:

- `0`
- `> 0`

This is the visible 2D silhouette/shape of the part in screen space.

This is the object that should eventually be simplified into the rendered polygon.

### B. Spatial Edge Projection

Boundary where accumulation differs by `1`, such as:

- `0 / 1`
- `2 / 3`

These boundaries correspond to projected 3D spatial edges that remain distinguishable in the part projection.

They are not the final simplified contour themselves. They are **constraints / anchors** for segmentation and simplification.

## Why This Split Is Necessary

A raw screen contour may include regions created by screen-space bulging rather than true spatial adjacency.

Example:

- a skirt bulges outward
- in screen space it touches or approaches another part
- but in 3D space it is not actually connected there

That bulged contour can still be simplified inward.

However, the simplification should be limited by the projected spatial edges. If it crosses them, valid structural lines such as a waist boundary can disappear incorrectly.

So:

- screen contour = what can be simplified
- spatial edge projection = where simplification must be constrained

## Simplification Logic

For each part:

1. Use the global ID mask to determine which pixels are visible.
2. Build the part's own accumulation mask.
3. Extract:
   - screen contour from `0` vs `>0`
   - spatial-edge projection from regions whose accumulation difference is `1`
4. Use the spatial-edge projection to split the contour into segments.
5. Simplify each segment independently.
6. Rebuild the final contour without allowing simplified segments to cross their spatial-edge limits.

## Design Consequence

Shared-border synchronization should not be driven only by current screen-space nearest-point matching.

Instead, segmentation for simplification should be derived from projected spatial-edge constraints coming from the per-part accumulation mask model.
