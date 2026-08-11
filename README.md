# 2DRender Pipeline

```mermaid
flowchart TD
    A["Frame Scheduling (CPU)"]
    B["Mesh Projection (GPU)"]
    C["Part Rasterization (GPU)"]
    D["Part Shaping (CPU)"]
    E["Part Filtering (CPU)"]
    F["Composition (GPU)"]
    G["Right Canvas"]

    A -->|"scene, camera, root, parts, maskState, settings, frameId"| B
    B -->|"mesh screen coords + depth"| C
    C -->|"part masks"| D
    C -->|"depthAtlas"| F
    D -->|"ProjectedPartShape[]"| E
    E -->|"filtered ProjectedPartShape[]"| F
    F -->|"final 2D render"| G
```

| Processing | Main files |
| --- | --- |
| `Frame Scheduling (CPU)` | [ProjectionOverlay.tsx](src/components/ProjectionOverlay.tsx), [overlayPipeline.ts](src/lib/2DRenderPipeline/overlayPipeline.ts) |
| `Mesh Projection (GPU)` | [2DRenderStages/meshProjection/](src/lib/2DRenderStages/meshProjection/) |
| `Part Rasterization (GPU)` | [2DRenderStages/partRasterization/](src/lib/2DRenderStages/partRasterization/) |
| `Part Build (CPU)` | [2DRenderStages/partShaping/](src/lib/2DRenderStages/partShaping/) |
| `Part Filtering (CPU)` | [2DRenderStages/partFiltering/](src/lib/2DRenderStages/partFiltering/) |
| `Composition (GPU)` | [2DRenderStages/composition/](src/lib/2DRenderStages/composition/) |
| `Shared Data And Helpers` | [2DRenderShared/](src/lib/2DRenderShared/) |

## Flat-Paint Style

The overlay now derives three paint layers from the skinned face normals and a fixed world-space light:

- `shadow`: darker, warm-toned region
- `base`: sampled texture/material color
- `highlight`: lighter region

Each layer is rasterized independently, depth-filtered against the other projected layers, simplified into a 2D contour, and composed with the configurable warm outline and background color.

The PMX/VMD assets are intentionally external. The downloaded `models` directory is mirrored into `public/models` for Vite's static serving:

```text
models/可琳_by_绝区零_2bdf4e664d2349e13c899f884728ce53/可琳.pmx
models/vmd/Aerial.vmd
```

The 2D view requires WebGPU. Unsupported browsers keep the Three.js viewport visible and show a capability message in the result pane.
