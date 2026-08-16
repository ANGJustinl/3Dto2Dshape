#include "../raster_contour.h"

#include <cassert>
#include <cstdint>
#include <cstring>
#include <vector>

static std::uint32_t read_u32(const std::vector<std::uint8_t>& bytes, std::size_t offset) {
    std::uint32_t value = 0;
    std::memcpy(&value, bytes.data() + offset, sizeof(value));
    return value;
}

int main() {
    // Two overlapping triangles: part 0 is nearer and must own the overlap.
    const float triangles[] = {
        2, 2, 0.2f, 14, 2, 0.2f, 2, 14, 0.2f,
        2, 2, 0.8f, 14, 2, 0.8f, 14, 14, 0.8f,
    };
    const std::int32_t offsets[] = {0, 1};
    const std::int32_t counts[] = {1, 1};
    const float fallback[] = {0.2f, 0.8f};

    const std::int32_t required = rasterize_contour_batch(
        16, 16, triangles, 2, offsets, counts, fallback, 2, nullptr, 0);
    assert(required > 0);
    std::vector<std::uint8_t> output(static_cast<std::size_t>(required));
    const std::int32_t written = rasterize_contour_batch(
        16, 16, triangles, 2, offsets, counts, fallback, 2, output.data(), required);
    assert(written == required);
    assert(read_u32(output, 0) == 0x32525343);
    assert(read_u32(output, 8) == 2);
    assert(read_u32(output, 20) >= 1);
    assert(read_u32(output, 24) == 1);
    assert(read_u32(output, 24 + 48) == 1);
    return 0;
}
