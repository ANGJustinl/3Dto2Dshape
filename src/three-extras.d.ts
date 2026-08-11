declare module 'three/examples/jsm/animation/MMDAnimationHelper.js' {
    export class MMDAnimationHelper {
        constructor(parameters?: Record<string, unknown>);
        objects: Map<unknown, { mixer?: import('three').AnimationMixer }>;
        add(object: import('three').Object3D, parameters?: Record<string, unknown>): void;
        remove(object: import('three').Object3D): void;
        update(delta: number): void;
    }
}
