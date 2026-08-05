import * as THREE from 'three';
import type { ProjectionPartSource, ProjectionSharedChain } from '../modelParts';
import type { ProjectionMaskState } from './types';

export const createProjectionMaskState = (
    _root: THREE.Object3D,
    _leafMaterialMap: Map<string, THREE.Material>,
    _parts: ProjectionPartSource[],
    sharedChains: ProjectionSharedChain[],
) => {
    return {
        sharedChains,
    } satisfies ProjectionMaskState;
};
