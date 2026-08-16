#pragma once

#include <cstdint>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define RASTER_CONTOUR_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define RASTER_CONTOUR_EXPORT
#endif

extern "C" {

RASTER_CONTOUR_EXPORT int32_t rasterize_contour_batch(
    int32_t viewport_width,
    int32_t viewport_height,
    const float* triangles,
    int32_t triangle_count,
    const int32_t* part_triangle_offsets,
    const int32_t* part_triangle_counts,
    const float* fallback_depth,
    int32_t part_count,
    std::uint8_t* output,
    int32_t output_capacity);

RASTER_CONTOUR_EXPORT const char* raster_contour_last_error();

}
