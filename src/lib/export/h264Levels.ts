// H.264 Annex A frame, macroblock-rate and NAL bitrate limits.
// Primary reference: https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/h264_levels.c
// Keep the existing level-4 floor for small exports, and raise it when the
// dimensions, framerate or bitrate require a higher level.
const levels = [
    {id: 40, macroblocks: 8192, rate: 245760, bitrateKbps: 20000},
    {id: 41, macroblocks: 8192, rate: 245760, bitrateKbps: 50000},
    {id: 42, macroblocks: 8704, rate: 522240, bitrateKbps: 50000},
    {id: 50, macroblocks: 22080, rate: 589824, bitrateKbps: 135000},
    {id: 51, macroblocks: 36864, rate: 983040, bitrateKbps: 240000},
    {id: 52, macroblocks: 36864, rate: 2073600, bitrateKbps: 240000},
    {id: 60, macroblocks: 139264, rate: 4177920, bitrateKbps: 240000},
    {id: 61, macroblocks: 139264, rate: 8355840, bitrateKbps: 480000},
    {id: 62, macroblocks: 139264, rate: 16711680, bitrateKbps: 800000},
];

export function h264CodecCandidates(width: number, height: number, fps: number, bitrate: number) {
    if (![width, height, fps, bitrate].every(value => Number.isFinite(value) && value > 0)) {
        throw new Error('Invalid MP4 video dimensions, framerate or bitrate.');
    }
    const columns = Math.ceil(width / 16), rows = Math.ceil(height / 16);
    const count = columns * rows;
    return [
        {prefix: 'avc1.6400', bitrateFactor: 1500},
        {prefix: 'avc1.4d40', bitrateFactor: 1200},
        {prefix: 'avc1.4200', bitrateFactor: 1200},
    ].flatMap(profile => {
        const level = levels.find(level =>
            count <= level.macroblocks && count * fps <= level.rate &&
            columns * columns <= 8 * level.macroblocks && rows * rows <= 8 * level.macroblocks &&
            bitrate <= level.bitrateKbps * profile.bitrateFactor);
        return level ? [{codec: profile.prefix + level.id.toString(16).padStart(2, '0'), muxCodec: 'avc'}] : [];
    });
}
