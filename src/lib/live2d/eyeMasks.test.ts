import { expect, it } from 'vitest';
import { resolveEyeMaskIds } from './eyeMasks';

it('clips eye interiors against face coverage but preserves lashes and brows', () => {
    const parts = ['目', '目光', '目影', '白目', '睫', '二重', '眉', '颜'].map((label) => ({ id: label, label, meshId: 'a' }));
    const other = { id: 'other', label: '颜', meshId: 'b' };
    for (const part of parts.slice(0, 4)) expect(resolveEyeMaskIds(part, [other, ...parts])).toEqual(['颜']);
    for (const part of parts.slice(4)) expect(resolveEyeMaskIds(part, parts)).toBeUndefined();
    expect(resolveEyeMaskIds(parts[0], [other])).toBeUndefined();
});
