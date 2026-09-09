import { expect, it } from 'vitest';
import { enforceMouthOrder, resolveMouthMaskIds } from './mouthMasks';

it('places mouth above its own face and below foreground hair', () => {
    const parts = ['口舌', '齿', '颜', '口线', '前髪'].map((label) => ({ id: label, label, meshId: 'a' }));
    expect(enforceMouthOrder(parts, parts.map((d) => d.id))).toEqual(['颜', '口舌', '齿', '口线', '前髪']);
    expect(resolveMouthMaskIds(parts[0], parts)).toEqual(['颜']);
    expect(resolveMouthMaskIds(parts[0], parts.filter((d) => d.label !== '颜'))).toBeUndefined();
});

it('restores bangs above the face when frontal depth ranking buries them', () => {
    const names = ['前髪', '颜', '目', '睫'];
    const parts = names.map((label) => ({ id: label, label, meshId: 'a' }));
    expect(enforceMouthOrder(parts, names)).toEqual(['颜', '目', '睫', '前髪']);
});

it('keeps recessed eye layers above the face without moving foreground hair behind them', () => {
    const names = ['后髪', '白目', '目', '睫', '颜', '口线', '前髪'];
    const parts = names.map((label) => ({ id: label, label, meshId: 'a' }));
    expect(enforceMouthOrder(parts, names)).toEqual(['后髪', '颜', '白目', '目', '睫', '口线', '前髪']);
});
