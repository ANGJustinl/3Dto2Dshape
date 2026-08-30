import { useEffect, useRef, useState } from 'react';
import { buildMoc3Archive } from '../lib/live2d/moc3';
import { defaultPngCodec, exportModel, importModel, verifyRoundtripBytes } from '../lib/live2d/serialize';
import { Live2dPreviewRuntime } from '../lib/live2d/runtime';
import { applyExpression, parseExpression, type ParsedExpression } from '../lib/live2d/expression';
import { createDemoIdleMotion, evaluateMotion, parseMotion, type ParsedMotion } from '../lib/live2d/motion';
import type { Live2dModel } from '../lib/live2d/model';
import type { FaceParamId, ParamAssignment } from '../lib/live2d/types';

type Live2DPreviewPanelProps = {
    model: Live2dModel;
    onImportModel: (model: Live2dModel) => void;
};

type RoundtripResult = {
    zipBytes: number;
    byteProblems: string[];
    pixelIdentical: boolean;
    pixelReport: {
        environmentDiffPixels: number;
        formatDiffPixels: number;
        maxDelta: number;
        totalPixels: number;
        firstFormatMismatch: string | null;
    };
};

const Live2DPreviewPanel = ({ model, onImportModel }: Live2DPreviewPanelProps) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const runtimeRef = useRef<Live2dPreviewRuntime | null>(null);
    const [assignment, setAssignment] = useState<ParamAssignment>(() => {
        const initial = {} as ParamAssignment;
        model.params.forEach((param) => {
            initial[param.id] = param.default;
        });
        return initial;
    });
    const [roundtrip, setRoundtrip] = useState<RoundtripResult | null>(null);
    const [roundtripError, setRoundtripError] = useState<string | null>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [moc3Error, setMoc3Error] = useState<string | null>(null);
    const [motion, setMotion] = useState<ParsedMotion | null>(null);
    const [playing, setPlaying] = useState(false);
    const [expression, setExpression] = useState<ParsedExpression | null>(null);
    const [motionError, setMotionError] = useState<string | null>(null);
    const playTimeRef = useRef(0);
    const progressRef = useRef<HTMLSpanElement | null>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const runtime = new Live2dPreviewRuntime(canvas, model);
        runtimeRef.current = runtime;
        setMotion(null);
        setPlaying(false);
        return () => {
            runtimeRef.current = null;
            runtime.dispose();
        };
    }, [model]);

    const composePose = (base: ParamAssignment): ParamAssignment => {
        const runtime = runtimeRef.current;
        if (!runtime) {
            return base;
        }
        const motionSample = motion ? evaluateMotion(motion, playTimeRef.current) : null;
        const posed: ParamAssignment = { ...base, ...(motionSample?.parameters ?? {}) };
        const withExpression = expression ? applyExpression(posed, expression) : posed;
        if (motionSample) {
            Object.entries(motionSample.partOpacities).forEach(([drawableId, opacity]) => {
                runtime.setDrawableOpacity(drawableId, opacity);
            });
        } else {
            runtime.resetDrawableOpacities();
        }
        return withExpression;
    };

    // Motion playback: rAF loop advancing playTime and re-rendering. Slider
    // state is not synced per frame (the pose is composed in the runtime).
    useEffect(() => {
        if (!playing || !motion || !runtimeRef.current) {
            return;
        }
        let frameHandle = 0;
        let lastTick = performance.now();
        const defaults = {} as ParamAssignment;
        model.params.forEach((param) => {
            defaults[param.id] = param.default;
        });
        const tick = (now: number) => {
            const delta = (now - lastTick) / 1000;
            lastTick = now;
            playTimeRef.current += delta;
            if (progressRef.current) {
                progressRef.current.textContent = `${playTimeRef.current.toFixed(1)}s / ${motion.duration.toFixed(1)}s`;
            }
            const runtime = runtimeRef.current;
            if (runtime) {
                runtime.setAssignment(composePose(defaults));
                runtime.render();
            }
            frameHandle = requestAnimationFrame(tick);
        };
        frameHandle = requestAnimationFrame(tick);
        return () => {
            cancelAnimationFrame(frameHandle);
        };
        // composePose reads motion/expression refs via closure; restart on changes
    }, [playing, motion, expression, model]);

    const handleSlider = (id: FaceParamId, value: number) => {
        const next = { ...assignment, [id]: value };
        setAssignment(next);
        const runtime = runtimeRef.current;
        if (!runtime) {
            return;
        }
        runtime.setAssignment(composePose(next));
        runtime.render();
    };

    const handleReset = () => {
        const runtime = runtimeRef.current;
        setExpression(null);
        if (runtime) {
            runtime.reset();
            runtime.resetDrawableOpacities();
            runtime.render();
        }
        const next = {} as ParamAssignment;
        model.params.forEach((param) => {
            next[param.id] = param.default;
        });
        setAssignment(next);
    };

    const handleExport = () => {
        const zipBytes = exportModel(model);
        const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${model.modelName || 'live2d'}-model.zip`;
        anchor.click();
        URL.revokeObjectURL(url);
    };

    // L2: Cubism-oriented export (model.moc3 + atlas texture + model3.json).
    // Positions come from the additive keyform grid, so the result is a
    // coarse approximation by design; validate in Cubism Viewer/VTube Studio.
    const handleExportMoc3 = () => {
        try {
            const zipBytes = buildMoc3Archive(model, defaultPngCodec.encode);
            setMoc3Error(null);
            const blob = new Blob([zipBytes.buffer as ArrayBuffer], { type: 'application/zip' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `${model.modelName || 'live2d'}-cubism.zip`;
            anchor.click();
            URL.revokeObjectURL(url);
        } catch (error) {
            setMoc3Error(error instanceof Error ? error.message : String(error));
        }
    };

    const handleImportFile = async (file: File) => {
        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            const imported = await importModel(bytes);
            onImportModel(imported);
            setImportError(null);
        } catch (error) {
            setImportError(error instanceof Error ? error.message : String(error));
        }
    };

    const handleRoundtrip = async () => {
        try {
            setRoundtripError(null);
            setRoundtrip(null);
            const runtime = runtimeRef.current;
            const sourceCanvas = canvasRef.current;
            if (!runtime || !sourceCanvas) {
                return;
            }
            const zipBytes = exportModel(model);
            const imported = await importModel(zipBytes);
            const byteProblems = verifyRoundtripBytes(model, imported);

            // A/B render with per-pixel tolerance: canvas PNG round-trips
            // perturb semi-transparent edge pixels slightly.
            const width = sourceCanvas.width;
            const height = sourceCanvas.height;
            const makeOffscreenRuntime = (source: typeof model) => {
                const offscreenCanvas = document.createElement('canvas');
                offscreenCanvas.width = width;
                offscreenCanvas.height = height;
                const offscreenRuntime = new Live2dPreviewRuntime(offscreenCanvas, source);
                offscreenRuntime.setAssignment(runtime.getAssignment());
                offscreenRuntime.render();
                return { offscreenCanvas, offscreenRuntime };
            };
            // Control: the ORIGINAL model rendered offscreen. Any diff between
            // this and the on-screen canvas is environmental, not the format.
            const control = makeOffscreenRuntime(model);
            // Experiment: the IMPORTED model through the same offscreen path.
            const scratch = makeOffscreenRuntime(imported);

            const readPixels = async (canvas: HTMLCanvasElement) => {
                // Every canvas goes through the IDENTICAL png -> bitmap -> 2d
                // -> ImageData path, so premultiply conversions apply
                // symmetrically and the comparison stays fair.
                const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
                if (!blob) {
                    throw new Error('Canvas encode failed during roundtrip check.');
                }
                const bitmap = await createImageBitmap(blob);
                const target = document.createElement('canvas');
                target.width = bitmap.width;
                target.height = bitmap.height;
                const context = target.getContext('2d');
                if (!context) {
                    throw new Error('Canvas 2D context unavailable.');
                }
                context.drawImage(bitmap, 0, 0);
                const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
                bitmap.close();
                return data;
            };
            const referencePixels = await readPixels(sourceCanvas);
            const controlPixels = await readPixels(control.offscreenCanvas);
            const scratchPixels = await readPixels(scratch.offscreenCanvas);
            // Dispose only after the canvases have been read: dispose() drops
            // the GL context and blanks the canvas.
            control.offscreenRuntime.dispose();
            scratch.offscreenRuntime.dispose();

            const pixelDiff = (left: Uint8ClampedArray, right: Uint8ClampedArray) => {
                let differingPixels = 0;
                let maxDelta = 0;
                let firstMismatch: string | null = null;
                if (left.length !== right.length) {
                    return { differingPixels: Number.POSITIVE_INFINITY, maxDelta: 255, firstMismatch };
                }
                for (let pixel = 0; pixel < left.length; pixel += 4) {
                    let pixelDelta = 0;
                    for (let channel = 0; channel < 4; channel += 1) {
                        pixelDelta = Math.max(pixelDelta, Math.abs(left[pixel + channel] - right[pixel + channel]));
                    }
                    maxDelta = Math.max(maxDelta, pixelDelta);
                    if (pixelDelta > 3) {
                        differingPixels += 1;
                        if (!firstMismatch) {
                            const pixelIndex = pixel / 4;
                            firstMismatch = `(${pixelIndex % width},${Math.floor(pixelIndex / width)}) a=[${left[pixel]},${left[pixel + 1]},${left[pixel + 2]},${left[pixel + 3]}] b=[${right[pixel]},${right[pixel + 1]},${right[pixel + 2]},${right[pixel + 3]}]`;
                        }
                    }
                }
                return { differingPixels, maxDelta, firstMismatch };
            };
            const environmentDiff = pixelDiff(referencePixels, controlPixels);
            const formatDiff = pixelDiff(controlPixels, scratchPixels);

            setRoundtrip({
                zipBytes: zipBytes.byteLength,
                byteProblems,
                pixelIdentical:
                    byteProblems.length === 0 &&
                    environmentDiff.differingPixels === 0 &&
                    formatDiff.differingPixels === 0,
                pixelReport: {
                    environmentDiffPixels: environmentDiff.differingPixels,
                    formatDiffPixels: formatDiff.differingPixels,
                    maxDelta: Math.max(environmentDiff.maxDelta, formatDiff.maxDelta),
                    totalPixels: referencePixels.length / 4,
                    firstFormatMismatch: formatDiff.firstMismatch,
                },
            });
        } catch (error) {
            setRoundtripError(error instanceof Error ? error.message : String(error));
        }
    };

    const errorReport = model.errorReport;

    return (
        <details className="export-panel" open>
            <summary>Live2D Preview</summary>
            <div className="export-panel-body">
                <canvas
                    ref={canvasRef}
                    className="live2d-preview-canvas"
                    width={1024}
                    height={1024}
                />
                {model.params.map((param) => (
                    <label key={param.id} className="projection-select live2d-param">
                        <span>
                            {param.label} ({param.id})
                        </span>
                        <input
                            type="range"
                            min={param.min}
                            max={param.max}
                            step={(param.max - param.min) / 60}
                            value={assignment[param.id] ?? param.default}
                            onChange={(event) => handleSlider(param.id, Number(event.currentTarget.value))}
                        />
                        <span>{(assignment[param.id] ?? param.default).toFixed(2)}</span>
                    </label>
                ))}
                <div className="export-grid-2">
                    <button type="button" className="part-chip" onClick={handleReset}>
                        Reset pose
                    </button>
                    <button type="button" className="part-chip active" onClick={handleRoundtrip}>
                        Roundtrip test
                    </button>
                    <button type="button" className="part-chip" onClick={handleExport}>
                        Export .zip
                    </button>
                    <button type="button" className="part-chip" onClick={handleExportMoc3}>
                        Export .moc3
                    </button>
                    {moc3Error ? <span className="export-error">{moc3Error}</span> : null}
                    <label className="part-chip live2d-import-label">
                        Import .zip
                        <input
                            type="file"
                            accept=".zip,application/zip"
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (file) {
                                    void handleImportFile(file);
                                }
                            }}
                        />
                    </label>
                </div>
                <div className="export-grid-2">
                    <button
                        type="button"
                        className="part-chip"
                        onClick={() => {
                            playTimeRef.current = 0;
                            setMotion(createDemoIdleMotion(model.params));
                            setMotionError(null);
                        }}
                    >
                        Demo idle motion
                    </button>
                    {motion ? (
                        <button
                            type="button"
                            className="part-chip active"
                            onClick={() => {
                                setPlaying((current) => !current);
                            }}
                        >
                            {playing ? 'Pause' : 'Play'}
                        </button>
                    ) : null}
                    <label className="part-chip live2d-import-label">
                        Load motion3.json
                        <input
                            type="file"
                            accept=".json,application/json"
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (!file) {
                                    return;
                                }
                                void file
                                    .text()
                                    .then((text) => {
                                        playTimeRef.current = 0;
                                        setMotion(parseMotion(JSON.parse(text)));
                                        setMotionError(null);
                                    })
                                    .catch((error) => {
                                        setMotionError(error instanceof Error ? error.message : String(error));
                                    });
                            }}
                        />
                    </label>
                    <label className="part-chip live2d-import-label">
                        Load expression
                        <input
                            type="file"
                            accept=".json,application/json"
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                if (!file) {
                                    return;
                                }
                                void file
                                    .text()
                                    .then((text) => {
                                        setExpression(parseExpression(JSON.parse(text)));
                                        setMotionError(null);
                                    })
                                    .catch((error) => {
                                        setMotionError(error instanceof Error ? error.message : String(error));
                                    });
                            }}
                        />
                    </label>
                </div>
                {motion ? (
                    <div className="export-hint">
                        motion: {motion.curves.length} curves · <span ref={progressRef}>0.0s / {motion.duration.toFixed(1)}s</span>
                        {expression ? ' · expression active' : ''}
                    </div>
                ) : null}
                {motionError ? <div className="export-error">{motionError}</div> : null}
                <div className="export-hint">
                    <div>
                        {model.drawables.length} drawables · {Object.keys(model.families).length} families ·
                        {' '}combo error mean {errorReport.meanErrorPx.toFixed(2)}px / max{' '}
                        {errorReport.maxErrorPx.toFixed(2)}px
                    </div>
                    {errorReport.worstDrawable ? (
                        <div>
                            worst drawable: {errorReport.worstDrawable.label} (
                            {errorReport.worstDrawable.meanPx.toFixed(2)}px)
                        </div>
                    ) : null}
                    <div>order flips: {model.orderReport.flips.length} / {model.orderReport.samplesChecked} samples</div>
                </div>
                {roundtrip ? (
                    <div className={roundtrip.pixelIdentical ? 'export-hint' : 'export-error'}>
                        Roundtrip: {(roundtrip.zipBytes / 1024 / 1024).toFixed(1)} MB zip ·{' '}
                        {roundtrip.pixelIdentical
                            ? 'byte + pixel identical'
                            : `MISMATCH — env diff ${roundtrip.pixelReport.environmentDiffPixels} px, format diff ${roundtrip.pixelReport.formatDiffPixels}/${roundtrip.pixelReport.totalPixels} px, max Δ${roundtrip.pixelReport.maxDelta}`}
                        {roundtrip.byteProblems.slice(0, 3).map((problem) => (
                            <div key={problem}>{problem}</div>
                        ))}
                        {roundtrip.pixelReport.firstFormatMismatch ? (
                            <div>first: {roundtrip.pixelReport.firstFormatMismatch}</div>
                        ) : null}
                    </div>
                ) : null}
                {roundtripError ? <div className="export-error">{roundtripError}</div> : null}
                {importError ? <div className="export-error">{importError}</div> : null}
            </div>
        </details>
    );
};

export default Live2DPreviewPanel;
