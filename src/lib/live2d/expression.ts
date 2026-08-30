import type { FaceParamId, ParamAssignment } from './types';

/**
 * L1: Cubism exp3.json import. Expressions override parameters on top of the
 * current pose with add/multiply/overwrite blending, exactly like the
 * official runtime semantics; ids outside the model are ignored.
 */

export type ExpressionBlend = 'add' | 'multiply' | 'overwrite';

export type ParsedExpression = {
    fadeInTime: number;
    parameters: Array<{ id: string; value: number; blend: ExpressionBlend }>;
};

export const parseExpression = (json: unknown): ParsedExpression => {
    const source = json as {
        Type?: string;
        FadeInTime?: number;
        Parameters?: Array<{ Id?: string; Value?: number; Blend?: string }>;
    };
    if (!source || !Array.isArray(source.Parameters)) {
        throw new Error('Not an exp3.json document: Parameters array missing.');
    }
    const parameters = source.Parameters.flatMap((parameter) => {
        if (typeof parameter.Id !== 'string' || typeof parameter.Value !== 'number') {
            return [];
        }
        const blend: ExpressionBlend =
            parameter.Blend === 'multiply' || parameter.Blend === 'overwrite' ? parameter.Blend : 'add';
        return [{ id: parameter.Id, value: parameter.Value, blend }];
    });
    return { fadeInTime: Math.max(0, source.FadeInTime ?? 1), parameters };
};

export const applyExpression = (
    base: ParamAssignment,
    expression: ParsedExpression,
    weight = 1,
): ParamAssignment => {
    const next = { ...base };
    expression.parameters.forEach((parameter) => {
        if (!(parameter.id in next)) {
            return;
        }
        const id = parameter.id as FaceParamId;
        if (parameter.blend === 'overwrite') {
            next[id] = parameter.value * weight + base[id] * (1 - weight);
        } else if (parameter.blend === 'multiply') {
            next[id] = base[id] * (1 + (parameter.value - 1) * weight);
        } else {
            next[id] = base[id] + parameter.value * weight;
        }
    });
    return next;
};
