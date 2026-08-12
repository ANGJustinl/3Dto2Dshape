import type { ProjectionPartSource } from '../modelParts';
import type {
    FocusLevel,
    MacroGroup,
    MeshProjectionCache,
    ProjectionOverlaySettings,
} from './types';

export type ResolvedPartStyle = {
    focusLevel: Exclude<FocusLevel, 'auto'>;
    macroGroup: MacroGroup;
    shapeBudget: number;
    simplifyMultiplier: number;
    accentScore: number;
    connectivityRole: 'normal' | 'bridge' | 'accent';
};

const keywordMatch = (value: string, keywords: string[]) => {
    const normalized = value.toLowerCase();
    return keywords.some((keyword) => normalized.includes(keyword.toLowerCase()));
};

const getProjectionBounds = (part: ProjectionPartSource, cache: MeshProjectionCache) => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let totalX = 0;
    let totalY = 0;
    let count = 0;

    part.triangles.forEach((triangle) => {
        triangle.vertexIndices.forEach((vertexIndex) => {
            const x = cache.screenX[vertexIndex];
            const y = cache.screenY[vertexIndex];
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                return;
            }
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            totalX += x;
            totalY += y;
            count += 1;
        });
    });

    if (!Number.isFinite(minX) || count === 0) {
        return null;
    }

    return {
        centerX: totalX / count,
        centerY: totalY / count,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY),
        area: Math.max(0, maxX - minX) * Math.max(0, maxY - minY),
    };
};

const inferMacroGroup = (
    part: ProjectionPartSource,
    centerX: number,
    centerY: number,
): MacroGroup => {
    // Use the leaf/material semantics first. Parent paths often contain
    // generic characters such as "面" and must not reclassify a hair mesh as
    // a face anchor.
    const directText = [part.label, ...part.materialNames].join(' ');
    if (keywordMatch(directText, ['hair', '髪', '发', '头发', 'bang', 'ponytail', '前髪'])) {
        return 'hair';
    }
    const faceSemantic = keywordMatch(directText, [
        'eye',
        'face',
        '眼',
        '脸',
        '颜',
        '瞳',
        '目',
        '睫',
        '眉',
        '口',
        '嘴',
        '齿',
    ]);
    const skinSemantic = keywordMatch(directText, ['skin', '肌', '皮肤']);
    const centralFace = centerX > 0.3 && centerX < 0.7 && centerY < 0.46;
    if (faceSemantic || (skinSemantic && centralFace)) {
        return 'face';
    }
    const text = [directText, part.parentPath].join(' ');
    if (keywordMatch(text, ['skirt', 'dress', 'cloth', '衣', '裙', '袖', 'shirt', 'top', 'body'])) {
        return 'torso';
    }
    if (
        centerY > 0.68 ||
        keywordMatch(text, ['shoe', 'leg', 'foot', 'base', 'cloud', '裙摆', '云', '下半', 'weapon'])
    ) {
        return 'lowerMass';
    }
    if (centerX > 0.2 && centerX < 0.8 && centerY < 0.45) {
        return 'accent';
    }
    return 'other';
};

const resolveAccentScore = (part: ProjectionPartSource, macroGroup: MacroGroup) => {
    const text = [part.label, ...part.materialNames].join(' ');
    if (macroGroup === 'face' || keywordMatch(text, ['eye', '眼', '瞳', '目'])) {
        return 1;
    }
    if (keywordMatch(text, ['mouth', '口', '嘴', '胸', '饰', '装饰', '金属', 'belt', '腰', '腕', '袖口', 'cuff'])) {
        return 0.86;
    }
    if (keywordMatch(text, ['weapon', '武器', '红', 'red', 'ribbon', '带'])) {
        return 0.78;
    }
    if (macroGroup === 'accent') {
        return 0.72;
    }
    if (keywordMatch(text, ['grid', '格', '褶', '皱'])) {
        return 0.34;
    }
    return macroGroup === 'lowerMass' ? 0.08 : 0.18;
};

const resolveConnectivityRole = (part: ProjectionPartSource, macroGroup: MacroGroup, centerY: number) => {
    const text = [part.label, ...part.materialNames].join(' ');
    if (keywordMatch(text, ['wrist', 'cuff', 'hand', '腕', '袖口', '袖', '手', 'forearm', '前臂'])) {
        return 'bridge' as const;
    }
    if (macroGroup === 'face' || macroGroup === 'accent' || keywordMatch(text, ['eye', '眼', '胸', '腰', '饰'])) {
        return 'accent' as const;
    }
    return centerY > 0.4 && centerY < 0.72 ? 'bridge' as const : 'normal' as const;
};

const inferFocusLevel = (
    macroGroup: MacroGroup,
    centerX: number,
    centerY: number,
    area: number,
    viewportWidth: number,
    viewportHeight: number,
): Exclude<FocusLevel, 'auto'> => {
    if (macroGroup === 'face' || macroGroup === 'accent') {
        return 'focal';
    }
    if (macroGroup === 'lowerMass') {
        return 'abstract';
    }

    const normalizedArea = area / Math.max(1, viewportWidth * viewportHeight);
    const centerDistance = Math.hypot(centerX / viewportWidth - 0.5, centerY / viewportHeight - 0.36);
    if (centerDistance < 0.24 && centerY / viewportHeight < 0.55 && normalizedArea < 0.2) {
        return 'focal';
    }
    return 'support';
};

export const resolvePartStyle = (
    part: ProjectionPartSource,
    projectionCache: MeshProjectionCache,
    settings: ProjectionOverlaySettings,
): ResolvedPartStyle => {
    const bounds = getProjectionBounds(part, projectionCache);
    const centerX = bounds?.centerX ?? projectionCache.width * 0.5;
    const centerY = bounds?.centerY ?? projectionCache.height * 0.5;
    const area = bounds?.area ?? 0;
    const macroGroup = inferMacroGroup(
        part,
        centerX / Math.max(1, projectionCache.width),
        centerY / Math.max(1, projectionCache.height),
    );
    const inferredFocus = inferFocusLevel(
        macroGroup,
        centerX,
        centerY,
        area,
        projectionCache.width,
        projectionCache.height,
    );
    const override = settings.partOverrides[part.leafId];
    const focusLevel = override?.focusLevel ?? inferredFocus;
    const defaultBudget = settings.focusShapeBudgets[focusLevel];
    const modeMultiplier = settings.styleMode === 'animationStable' ? 0.85 : 1.15;

    return {
        focusLevel,
        macroGroup,
        shapeBudget: Math.max(1, Math.round((override?.shapeBudget ?? defaultBudget) * modeMultiplier)),
        simplifyMultiplier: Math.max(
            0.25,
            (override?.simplifyMultiplier ?? 1) * (focusLevel === 'focal' ? 0.65 : focusLevel === 'abstract' ? 1.55 : 1),
        ),
        accentScore: resolveAccentScore(part, macroGroup),
        connectivityRole: resolveConnectivityRole(part, macroGroup, centerY / Math.max(1, projectionCache.height)),
    };
};

export const getStyleModeDefaults = (styleMode: ProjectionOverlaySettings['styleMode']) =>
    styleMode === 'animationStable'
        ? {
              minShapeAreaScale: 1.35,
              mergeGridScale: 4,
              edgeRoughnessScale: 0.45,
              temporalStability: 0.78,
          }
        : {
              minShapeAreaScale: 0.72,
              mergeGridScale: 3,
              edgeRoughnessScale: 1,
              temporalStability: 0,
          };
