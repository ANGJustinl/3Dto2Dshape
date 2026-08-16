#include "raster_contour.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

constexpr std::uint32_t kMagic = 0x32525343; // CRS2
constexpr std::uint32_t kVersion = 1;
constexpr std::size_t kHeaderBytes = 24;
constexpr std::size_t kDescriptorBytes = 48;
constexpr int kPadding = 2;

std::size_t align4(std::size_t value) {
    return (value + 3u) & ~std::size_t(3u);
}

struct Point {
    float x = 0;
    float y = 0;
};

struct Triangle {
    Point a;
    Point b;
    Point c;
    float da = 0;
    float db = 0;
    float dc = 0;
};

struct Bounds {
    int x = 0;
    int y = 0;
    int width = 0;
    int height = 0;
};

struct Edge {
    std::int64_t from = 0;
    std::int64_t to = 0;
};

struct PartResult {
    std::uint32_t status = 0;
    Bounds bounds;
    std::vector<std::uint8_t> mask;
    std::vector<float> depth;
    std::vector<std::vector<Point>> loops;
    float nearest_depth = std::numeric_limits<float>::infinity();
};

std::string g_last_error;

std::int64_t vertex_key(int x, int y) {
    return (static_cast<std::int64_t>(x) << 32) ^ static_cast<std::uint32_t>(y);
}

int vertex_x(std::int64_t key) {
    return static_cast<int>(key >> 32);
}

int vertex_y(std::int64_t key) {
    return static_cast<int>(static_cast<std::uint32_t>(key));
}

float edge_function(const Point& a, const Point& b, const Point& p) {
    return (p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x);
}

float triangle_area(const Triangle& triangle) {
    return edge_function(triangle.a, triangle.b, triangle.c);
}

bool inside_triangle(const Triangle& triangle, float x, float y) {
    const Point p{x, y};
    const float area = triangle_area(triangle);
    if (std::abs(area) < 1e-6f) {
        return false;
    }
    const float e0 = edge_function(triangle.a, triangle.b, p);
    const float e1 = edge_function(triangle.b, triangle.c, p);
    const float e2 = edge_function(triangle.c, triangle.a, p);
    const float epsilon = -1e-5f;
    return (e0 >= epsilon && e1 >= epsilon && e2 >= epsilon) ||
           (e0 <= -epsilon && e1 <= -epsilon && e2 <= -epsilon);
}

float interpolate_depth(const Triangle& triangle, float x, float y) {
    const float area = triangle_area(triangle);
    if (std::abs(area) < 1e-6f) {
        return std::min(triangle.da, std::min(triangle.db, triangle.dc));
    }
    const Point p{x, y};
    const float w0 = edge_function(triangle.b, triangle.c, p) / area;
    const float w1 = edge_function(triangle.c, triangle.a, p) / area;
    const float w2 = edge_function(triangle.a, triangle.b, p) / area;
    return triangle.da * w0 + triangle.db * w1 + triangle.dc * w2;
}

Bounds compute_bounds(const std::vector<Triangle>& triangles, int viewport_width, int viewport_height) {
    float min_x = std::numeric_limits<float>::infinity();
    float min_y = std::numeric_limits<float>::infinity();
    float max_x = -std::numeric_limits<float>::infinity();
    float max_y = -std::numeric_limits<float>::infinity();
    for (const auto& triangle : triangles) {
        min_x = std::min(min_x, std::min(triangle.a.x, std::min(triangle.b.x, triangle.c.x)));
        min_y = std::min(min_y, std::min(triangle.a.y, std::min(triangle.b.y, triangle.c.y)));
        max_x = std::max(max_x, std::max(triangle.a.x, std::max(triangle.b.x, triangle.c.x)));
        max_y = std::max(max_y, std::max(triangle.a.y, std::max(triangle.b.y, triangle.c.y)));
    }
    if (!std::isfinite(min_x) || !std::isfinite(min_y)) {
        return {};
    }
    const int x = std::max(0, static_cast<int>(std::floor(min_x)) - kPadding);
    const int y = std::max(0, static_cast<int>(std::floor(min_y)) - kPadding);
    const int max_x_i = std::min(viewport_width, static_cast<int>(std::ceil(max_x)) + kPadding);
    const int max_y_i = std::min(viewport_height, static_cast<int>(std::ceil(max_y)) + kPadding);
    return {x, y, max_x_i - x, max_y_i - y};
}

void add_edge(std::vector<Edge>& edges, std::unordered_map<std::int64_t, std::vector<int>>& outgoing,
              int from_x, int from_y, int to_x, int to_y) {
    const int index = static_cast<int>(edges.size());
    edges.push_back({vertex_key(from_x, from_y), vertex_key(to_x, to_y)});
    outgoing[edges.back().from].push_back(index);
}

void remove_collinear(std::vector<Point>& loop) {
    if (loop.size() < 3) {
        return;
    }
    std::vector<Point> simplified;
    simplified.reserve(loop.size());
    for (std::size_t index = 0; index < loop.size(); ++index) {
        const Point& previous = loop[(index + loop.size() - 1) % loop.size()];
        const Point& current = loop[index];
        const Point& next = loop[(index + 1) % loop.size()];
        const float cross = (current.x - previous.x) * (next.y - current.y) -
                            (current.y - previous.y) * (next.x - current.x);
        if (std::abs(cross) > 1e-5f) {
            simplified.push_back(current);
        }
    }
    loop.swap(simplified);
}

std::vector<std::vector<Point>> extract_loops(const std::vector<std::uint8_t>& mask, int width, int height,
                                              int offset_x, int offset_y) {
    if (width <= 0 || height <= 0 || mask.size() < static_cast<std::size_t>(width) * height) {
        return {};
    }

    std::vector<Edge> edges;
    std::unordered_map<std::int64_t, std::vector<int>> outgoing;
    auto occupied = [&](int x, int y) {
        return x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] != 0;
    };

    // Match the TypeScript run-length contour extractor. Maximal boundary
    // segments reduce ambiguous junctions and keep the WASM topology close
    // to the TypeScript baseline.
    for (int y = 0; y < height; ++y) {
        int x = 0;
        while (x < width) {
            if (!occupied(x, y)) {
                ++x;
                continue;
            }
            const bool top_boundary = !occupied(x, y - 1);
            const bool bottom_boundary = !occupied(x, y + 1);
            const int start_x = x;
            int end_x = x + 1;
            while (end_x < width && occupied(end_x, y) &&
                   (!occupied(end_x, y - 1) == top_boundary) &&
                   (!occupied(end_x, y + 1) == bottom_boundary)) {
                ++end_x;
            }
            if (top_boundary) add_edge(edges, outgoing, start_x, y, end_x, y);
            if (bottom_boundary) add_edge(edges, outgoing, end_x, y + 1, start_x, y + 1);
            x = end_x;
        }
    }

    for (int x = 0; x < width; ++x) {
        int y = 0;
        while (y < height) {
            if (!occupied(x, y)) {
                ++y;
                continue;
            }
            const bool left_boundary = !occupied(x - 1, y);
            const bool right_boundary = !occupied(x + 1, y);
            const int start_y = y;
            int end_y = y + 1;
            while (end_y < height && occupied(x, end_y) &&
                   (!occupied(x - 1, end_y) == left_boundary) &&
                   (!occupied(x + 1, end_y) == right_boundary)) {
                ++end_y;
            }
            if (right_boundary) add_edge(edges, outgoing, x + 1, start_y, x + 1, end_y);
            if (left_boundary) add_edge(edges, outgoing, x, end_y, x, start_y);
            y = end_y;
        }
    }

    std::vector<std::uint8_t> visited(edges.size(), 0);
    std::vector<std::vector<Point>> loops;
    for (std::size_t initial_edge = 0; initial_edge < edges.size(); ++initial_edge) {
        if (visited[initial_edge]) continue;
        const std::int64_t start = edges[initial_edge].from;
        std::int64_t current = start;
        int edge_index = static_cast<int>(initial_edge);
        bool closed = false;
        std::vector<std::int64_t> loop_ids{start};
        for (std::size_t guard = 0; guard < edges.size() * 2; ++guard) {
            visited[edge_index] = 1;
            current = edges[edge_index].to;
            if (current == start) {
                closed = true;
                break;
            }
            loop_ids.push_back(current);
            const auto it = outgoing.find(current);
            if (it == outgoing.end()) break;
            int next_edge = -1;
            for (int candidate : it->second) {
                if (!visited[candidate]) {
                    next_edge = candidate;
                    break;
                }
            }
            if (next_edge < 0) break;
            edge_index = next_edge;
        }
        if (!closed || loop_ids.size() < 3) continue;
        std::vector<Point> loop;
        loop.reserve(loop_ids.size());
        for (const auto id : loop_ids) {
            loop.push_back({static_cast<float>(vertex_x(id) + offset_x),
                            static_cast<float>(vertex_y(id) + offset_y)});
        }
        remove_collinear(loop);
        if (loop.size() >= 3) loops.push_back(std::move(loop));
    }
    return loops;
}

void write_u32(std::uint8_t* output, std::size_t offset, std::uint32_t value) {
    std::memcpy(output + offset, &value, sizeof(value));
}

void write_i32(std::uint8_t* output, std::size_t offset, std::int32_t value) {
    std::memcpy(output + offset, &value, sizeof(value));
}

void write_f32(std::uint8_t* output, std::size_t offset, float value) {
    std::memcpy(output + offset, &value, sizeof(value));
}

} // namespace

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
    int32_t output_capacity) {
    g_last_error.clear();
    if (viewport_width <= 0 || viewport_height <= 0 || triangle_count < 0 || part_count < 0 ||
        (!triangles && triangle_count > 0) || (!part_triangle_offsets && part_count > 0) ||
        (!part_triangle_counts && part_count > 0) || (!fallback_depth && part_count > 0)) {
        g_last_error = "Invalid raster contour input.";
        return -1;
    }

    try {
        std::vector<std::vector<Triangle>> part_triangles(static_cast<std::size_t>(part_count));
        for (int part = 0; part < part_count; ++part) {
            const int offset = part_triangle_offsets[part];
            const int count = part_triangle_counts[part];
            if (offset < 0 || count < 0 || offset + count > triangle_count) {
                g_last_error = "Part triangle range is invalid.";
                return -2;
            }
            auto& target = part_triangles[part];
            target.reserve(static_cast<std::size_t>(count));
            for (int index = 0; index < count; ++index) {
                const float* source = triangles + static_cast<std::size_t>(offset + index) * 9;
                target.push_back({
                    {source[0], source[1]}, {source[3], source[4]}, {source[6], source[7]},
                    source[2], source[5], source[8],
                });
            }
        }

        const std::size_t pixel_count = static_cast<std::size_t>(viewport_width) * viewport_height;
        std::vector<PartResult> results(static_cast<std::size_t>(part_count));
        for (int part = 0; part < part_count; ++part) {
            auto& result = results[part];
            result.bounds = compute_bounds(part_triangles[part], viewport_width, viewport_height);
            if (result.bounds.width <= 1 || result.bounds.height <= 1) {
                continue;
            }
            result.mask.assign(static_cast<std::size_t>(result.bounds.width) * result.bounds.height, 0);
            result.depth.assign(result.mask.size(), std::numeric_limits<float>::infinity());
        }

        // Keep a raw depth buffer for every part, then apply the same global
        // visibility tolerance as the TypeScript path. The previous WASM
        // implementation stored only one owner per pixel, which incorrectly
        // discarded coplanar paint layers and produced background holes.
        std::vector<float> global_depth(pixel_count, std::numeric_limits<float>::infinity());
        for (int part = 0; part < part_count; ++part) {
            const auto& current = part_triangles[part];
            const auto& bounds = results[part].bounds;
            if (bounds.width <= 1 || bounds.height <= 1) {
                continue;
            }
            for (const auto& triangle : current) {
                const int min_x = std::max(0, static_cast<int>(std::floor(std::min({triangle.a.x, triangle.b.x, triangle.c.x}))));
                const int max_x = std::min(viewport_width - 1, static_cast<int>(std::ceil(std::max({triangle.a.x, triangle.b.x, triangle.c.x}))));
                const int min_y = std::max(0, static_cast<int>(std::floor(std::min({triangle.a.y, triangle.b.y, triangle.c.y}))));
                const int max_y = std::min(viewport_height - 1, static_cast<int>(std::ceil(std::max({triangle.a.y, triangle.b.y, triangle.c.y}))));
                if (min_x > max_x || min_y > max_y) continue;
                for (int y = min_y; y <= max_y; ++y) {
                    for (int x = min_x; x <= max_x; ++x) {
                        const float sample_x = static_cast<float>(x) + 0.5f;
                        const float sample_y = static_cast<float>(y) + 0.5f;
                        if (!inside_triangle(triangle, sample_x, sample_y)) continue;
                        const float depth = interpolate_depth(triangle, sample_x, sample_y);
                        const std::size_t pixel = static_cast<std::size_t>(y) * viewport_width + x;
                        const int local_x = x - bounds.x;
                        const int local_y = y - bounds.y;
                        if (local_x >= 0 && local_y >= 0 && local_x < bounds.width && local_y < bounds.height) {
                            const std::size_t local_index = static_cast<std::size_t>(local_y) * bounds.width + local_x;
                            results[part].depth[local_index] = std::min(results[part].depth[local_index], depth);
                        }
                        if (depth < global_depth[pixel]) {
                            global_depth[pixel] = depth;
                        }
                    }
                }
            }
        }

        std::size_t mask_bytes = 0;
        std::size_t depth_values = 0;
        std::size_t loop_count = 0;
        std::size_t point_count = 0;
        for (int part = 0; part < part_count; ++part) {
            auto& result = results[part];
            if (result.bounds.width <= 1 || result.bounds.height <= 1) continue;
            for (int y = 0; y < result.bounds.height; ++y) {
                for (int x = 0; x < result.bounds.width; ++x) {
                    const int screen_x = result.bounds.x + x;
                    const int screen_y = result.bounds.y + y;
                    const std::size_t global_index = static_cast<std::size_t>(screen_y) * viewport_width + screen_x;
                    const std::size_t local_index = static_cast<std::size_t>(y) * result.bounds.width + x;
                    const float raw_depth = result.depth[local_index];
                    if (!std::isfinite(raw_depth)) continue;
                    result.nearest_depth = std::min(result.nearest_depth, raw_depth);
                    if (raw_depth <= global_depth[global_index] + 0.0005f) {
                        result.mask[local_index] = 1;
                    }
                }
            }
            result.loops = extract_loops(result.mask, result.bounds.width, result.bounds.height, result.bounds.x, result.bounds.y);
            if (result.nearest_depth == std::numeric_limits<float>::infinity()) continue;
            result.status = 1;
            mask_bytes += result.mask.size();
            depth_values += result.depth.size();
            loop_count += result.loops.size();
            for (const auto& loop : result.loops) point_count += loop.size();
        }

        const std::size_t loopCountsBytes = loop_count * sizeof(std::uint32_t);
        const std::size_t descriptorBytes = static_cast<std::size_t>(part_count) * kDescriptorBytes;
        const std::size_t maskOffset = kHeaderBytes + descriptorBytes;
        const std::size_t depthOffset = align4(maskOffset + mask_bytes);
        const std::size_t outputBytes = kHeaderBytes + descriptorBytes + mask_bytes + depth_values * sizeof(float) +
                                        loopCountsBytes + point_count * sizeof(float) * 2 +
                                        (depthOffset - (maskOffset + mask_bytes));
        if (!output || output_capacity == 0) {
            if (outputBytes > static_cast<std::size_t>(std::numeric_limits<int32_t>::max())) {
                g_last_error = "WASM output is too large.";
                return -3;
            }
            return static_cast<int32_t>(outputBytes);
        }
        if (static_cast<std::size_t>(output_capacity) < outputBytes) {
            g_last_error = "WASM output buffer is too small.";
            return -4;
        }

        write_u32(output, 0, kMagic);
        write_u32(output, 4, kVersion);
        write_u32(output, 8, static_cast<std::uint32_t>(part_count));
        write_u32(output, 12, static_cast<std::uint32_t>(mask_bytes));
        write_u32(output, 16, static_cast<std::uint32_t>(depth_values));
        write_u32(output, 20, static_cast<std::uint32_t>(loop_count));
        std::size_t mask_offset = maskOffset;
        std::size_t depth_offset = depthOffset;
        std::size_t loop_offset = depth_offset + depth_values * sizeof(float);
        std::size_t point_offset = loop_offset + loopCountsBytes;
        std::size_t mask_cursor = 0;
        std::size_t depth_cursor = 0;
        std::size_t loop_cursor = 0;
        std::size_t point_cursor = 0;
        for (int part = 0; part < part_count; ++part) {
            const auto& result = results[part];
            const std::size_t descriptor = kHeaderBytes + static_cast<std::size_t>(part) * kDescriptorBytes;
            write_u32(output, descriptor, result.status);
            write_i32(output, descriptor + 4, result.bounds.x);
            write_i32(output, descriptor + 8, result.bounds.y);
            write_u32(output, descriptor + 12, static_cast<std::uint32_t>(result.bounds.width));
            write_u32(output, descriptor + 16, static_cast<std::uint32_t>(result.bounds.height));
            write_u32(output, descriptor + 20, static_cast<std::uint32_t>(mask_cursor));
            write_u32(output, descriptor + 24, static_cast<std::uint32_t>(depth_cursor));
            write_u32(output, descriptor + 28, static_cast<std::uint32_t>(loop_cursor));
            write_u32(output, descriptor + 32, static_cast<std::uint32_t>(result.loops.size()));
            write_f32(output, descriptor + 36, result.nearest_depth);
            write_u32(output, descriptor + 40, static_cast<std::uint32_t>(point_cursor));
            std::size_t points_in_part = 0;
            for (const auto& loop : result.loops) points_in_part += loop.size();
            write_u32(output, descriptor + 44, static_cast<std::uint32_t>(points_in_part));
            if (result.status == 0) continue;
            std::memcpy(output + mask_offset + mask_cursor, result.mask.data(), result.mask.size());
            std::memcpy(output + depth_offset + depth_cursor * sizeof(float), result.depth.data(), result.depth.size() * sizeof(float));
            for (const auto& loop : result.loops) {
                write_u32(output, loop_offset + loop_cursor * sizeof(std::uint32_t), static_cast<std::uint32_t>(loop.size()));
                ++loop_cursor;
                for (const auto& point : loop) {
                    write_f32(output, point_offset + point_cursor * sizeof(float) * 2, point.x);
                    write_f32(output, point_offset + point_cursor * sizeof(float) * 2 + sizeof(float), point.y);
                    ++point_cursor;
                }
            }
            mask_cursor += result.mask.size();
            depth_cursor += result.depth.size();
        }
        return static_cast<int32_t>(outputBytes);
    } catch (...) {
        g_last_error = "Unexpected raster contour failure.";
        return -5;
    }
}

RASTER_CONTOUR_EXPORT const char* raster_contour_last_error() {
    return g_last_error.c_str();
}

} // extern "C"
