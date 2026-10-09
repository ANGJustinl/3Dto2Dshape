import {describe, expect, it} from 'vitest';
import {h264CodecCandidates} from './h264Levels';

describe('MP4 codec profiles for actual export sizes', () => {
    it('retains the small preview export profile', () => {
        expect(h264CodecCandidates(960, 540, 60, 4_665_600)[0].codec).toBe('avc1.640028');
    });
    it('supports full-HD 60fps instead of requesting an insufficient level', () => {
        expect(h264CodecCandidates(1920, 1080, 60, 18_662_400)[0].codec).toBe('avc1.64002a');
    });
    it('distinguishes 4K 30fps and 60fps', () => {
        expect(h264CodecCandidates(3840, 2160, 30, 37_324_800)[0].codec).toBe('avc1.640033');
        expect(h264CodecCandidates(3840, 2160, 60, 74_649_600).map(candidate => candidate.codec)).toEqual(['avc1.640034', 'avc1.4d4034', 'avc1.420034']);
    });
    it('uses the bitrate and rectangular-frame limits as well as pixel count', () => {
        expect(h264CodecCandidates(1920, 1080, 30, 60_000_000)[0].codec).toBe('avc1.640029');
        expect(h264CodecCandidates(16384, 64, 30, 4_000_000)[0].codec).toBe('avc1.64003c');
    });
    it('rejects invalid values and offers no impossible profile', () => {
        expect(() => h264CodecCandidates(3840, 2160, 0, 4_000_000)).toThrow('Invalid MP4');
        expect(h264CodecCandidates(32768, 32768, 60, 1_000_000_000)).toEqual([]);
    });
});
