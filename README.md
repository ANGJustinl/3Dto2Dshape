# 2DRender Pipeline

```mermaid
flowchart TD
    A["Frame Scheduling (CPU)"]
    B["Mesh Projection (GPU)"]
    C["Part Rasterization (GPU)"]
    D["Part Build (CPU)"]
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
