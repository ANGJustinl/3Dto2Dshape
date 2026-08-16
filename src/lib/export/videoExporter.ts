export type ExportVideoSource = 'overlay2d' | 'model3d' | 'sideBySide';
export type ExportVideoFormat = 'webm' | 'mp4';

export type ExportVideoSettings = {
    source: ExportVideoSource;
    format: ExportVideoFormat;
    fps: number;
    startFrame: number;
    endFrame: number;
    frameStep: number;
    scale: number;
};

export type ExportFrameCanvases = {
    overlay: HTMLCanvasElement | null;
    model: HTMLCanvasElement | null;
};

export type ExportVideoProgress = {
    completed: number;
    total: number;
};

export type ExportFrameProvider = (frame: number) => Promise<ExportFrameCanvases>;

const MIME_CANDIDATES: Record<ExportVideoFormat, string[]> = {
    webm: [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
    ],
    mp4: [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1.42E01E',
        'video/mp4',
    ],
};

const canUseMediaRecorder = () =>
    typeof window !== 'undefined' &&
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function';

const getWebCodecs = () => {
    const scope = globalThis as typeof globalThis & {
        VideoEncoder?: any;
        VideoFrame?: any;
    };
    return {
        VideoEncoder: scope.VideoEncoder,
        VideoFrame: scope.VideoFrame,
    };
};

const canUseWebCodecs = () => {
    const { VideoEncoder, VideoFrame } = getWebCodecs();
    return typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';
};

export const isDeterministicExportAvailable = () => canUseWebCodecs();

export const getSupportedExportFormats = (): ExportVideoFormat[] => {
    const supported = new Set<ExportVideoFormat>();
    if (canUseMediaRecorder()) {
        (Object.keys(MIME_CANDIDATES) as ExportVideoFormat[]).forEach((format) => {
            if (MIME_CANDIDATES[format].some((mimeType) => MediaRecorder.isTypeSupported(mimeType))) {
                supported.add(format);
            }
        });
    }
    // WebCodecs uses a real timestamp per encoded frame and therefore avoids
    // MediaRecorder's wall-clock duration drift during expensive projection.
    if (canUseWebCodecs()) {
        supported.add('webm');
        supported.add('mp4');
    }
    return Array.from(supported);
};

const getSupportedMimeType = (format: ExportVideoFormat) => {
    if (!canUseMediaRecorder()) {
        throw new Error('This browser does not support canvas video recording.');
    }

    const mimeType = MIME_CANDIDATES[format].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) {
        throw new Error(`${format.toUpperCase()} is not supported by this browser.`);
    }
    return mimeType;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const drawCanvasCover = (
    context: CanvasRenderingContext2D,
    source: HTMLCanvasElement,
    x: number,
    y: number,
    width: number,
    height: number,
) => {
    const sourceAspect = source.width / Math.max(1, source.height);
    const targetAspect = width / Math.max(1, height);
    let drawWidth = width;
    let drawHeight = height;
    let drawX = x;
    let drawY = y;

    if (sourceAspect > targetAspect) {
        drawWidth = height * sourceAspect;
        drawX = x + (width - drawWidth) * 0.5;
    } else {
        drawHeight = width / sourceAspect;
        drawY = y + (height - drawHeight) * 0.5;
    }

    context.drawImage(source, drawX, drawY, drawWidth, drawHeight);
};

const drawExportFrame = (
    context: CanvasRenderingContext2D,
    target: HTMLCanvasElement,
    source: ExportVideoSource,
    canvases: ExportFrameCanvases,
) => {
    const overlay = canvases.overlay;
    const model = canvases.model;
    const background = '#000000';

    context.save();
    context.fillStyle = background;
    context.fillRect(0, 0, target.width, target.height);

    if (source === 'overlay2d') {
        if (!overlay) {
            throw new Error('The 2D result canvas is not ready.');
        }
        drawCanvasCover(context, overlay, 0, 0, target.width, target.height);
    } else if (source === 'model3d') {
        if (!model) {
            throw new Error('The 3D canvas is not ready.');
        }
        drawCanvasCover(context, model, 0, 0, target.width, target.height);
    } else {
        if (!overlay || !model) {
            throw new Error('The 3D or 2D canvas is not ready.');
        }
        const gap = Math.max(1, Math.round(target.width * 0.01));
        const paneWidth = Math.floor((target.width - gap) / 2);
        drawCanvasCover(context, model, 0, 0, paneWidth, target.height);
        drawCanvasCover(context, overlay, paneWidth + gap, 0, target.width - paneWidth - gap, target.height);
    }

    context.restore();
};

const getCanvasSize = (source: ExportVideoSource, canvases: ExportFrameCanvases, scale: number) => {
    if (source === 'sideBySide' && (!canvases.overlay || !canvases.model)) {
        throw new Error('The 3D or 2D canvas is not ready.');
    }
    const sourceCanvas = source === 'overlay2d'
        ? canvases.overlay
        : source === 'model3d'
          ? canvases.model
          : canvases.overlay;
    if (!sourceCanvas || sourceCanvas.width <= 0 || sourceCanvas.height <= 0) {
        throw new Error('The selected export canvas is not ready.');
    }

    if (source === 'sideBySide' && (
        !canvases.overlay || !canvases.model ||
        canvases.overlay.width <= 0 || canvases.overlay.height <= 0 ||
        canvases.model.width <= 0 || canvases.model.height <= 0
    )) {
        throw new Error('The 3D or 2D canvas is not ready.');
    }

    const width = source === 'sideBySide'
        ? canvases.overlay!.width + canvases.model!.width
        : sourceCanvas.width;
    const height = source === 'sideBySide'
        ? Math.max(canvases.overlay!.height, canvases.model!.height)
        : sourceCanvas.height;
    // Keep dimensions even so H.264 WebCodecs profiles do not reject a
    // viewport whose CSS size happens to be odd.
    const outputWidth = Math.max(2, Math.floor(Math.round(width * scale) / 2) * 2);
    const outputHeight = Math.max(2, Math.floor(Math.round(height * scale) / 2) * 2);
    if (outputWidth > 4096 || outputHeight > 4096) {
        throw new Error('The selected export resolution is above the 4096px safety limit.');
    }
    return { width: outputWidth, height: outputHeight };
};

const buildFrameList = (settings: ExportVideoSettings) => {
    const frames: number[] = [];
    const step = Math.max(1, Math.floor(settings.frameStep));
    for (let frame = settings.startFrame; frame <= settings.endFrame; frame += step) {
        frames.push(frame);
    }
    if (frames.length === 0 || frames[frames.length - 1] !== settings.endFrame) {
        frames.push(settings.endFrame);
    }
    return frames;
};

type ExportSurface = {
    staging: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    direct: HTMLCanvasElement | null;
};

const createExportSurface = (
    settings: ExportVideoSettings,
    firstFrame: ExportFrameCanvases,
    size: { width: number; height: number },
): ExportSurface => {
    const staging = document.createElement('canvas');
    staging.width = size.width;
    staging.height = size.height;
    const context = staging.getContext('2d');
    if (!context) {
        throw new Error('Could not create the export canvas context.');
    }

    const sourceCanvas = settings.source === 'overlay2d' ? firstFrame.overlay : firstFrame.model;
    const direct = settings.scale === 1 && settings.source !== 'sideBySide' &&
        sourceCanvas !== null && sourceCanvas.width === size.width && sourceCanvas.height === size.height
        ? settings.source === 'overlay2d'
            ? firstFrame.overlay
            : firstFrame.model
        : null;
    if (!direct) {
        drawExportFrame(context, staging, settings.source, firstFrame);
    }
    return { staging, context, direct };
};

const updateExportSurface = (
    surface: ExportSurface,
    settings: ExportVideoSettings,
    frame: ExportFrameCanvases,
) => {
    if (!surface.direct) {
        drawExportFrame(surface.context, surface.staging, settings.source, frame);
    }
    return surface.direct ?? surface.staging;
};

const downloadVideoBlob = (blob: Blob, settings: ExportVideoSettings) => {
    if (blob.size === 0) {
        throw new Error('The browser returned an empty video. Try WebM or a lower export resolution.');
    }
    const extension = settings.format === 'mp4' ? 'mp4' : 'webm';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `3dto2d-${settings.source}-${Date.now()}.${extension}`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const selectWebCodecsConfig = async (
    format: ExportVideoFormat,
    width: number,
    height: number,
    fps: number,
    bitrate: number,
) => {
    const { VideoEncoder } = getWebCodecs();
    if (!VideoEncoder) {
        throw new Error('WebCodecs VideoEncoder is not available.');
    }

    const candidates = format === 'webm'
        ? [
              { codec: 'vp09.00.10.08', muxCodec: 'V_VP9' },
              { codec: 'vp8', muxCodec: 'V_VP8' },
          ]
        : [
              { codec: 'avc1.640028', muxCodec: 'avc' },
              { codec: 'avc1.4d4028', muxCodec: 'avc' },
              { codec: 'avc1.42001f', muxCodec: 'avc' },
          ];

    for (const candidate of candidates) {
        const config = {
            codec: candidate.codec,
            width,
            height,
            bitrate,
            framerate: fps,
        };
        try {
            const support = await VideoEncoder.isConfigSupported(config);
            if (support?.supported) {
                return { config, muxCodec: candidate.muxCodec };
            }
        } catch {
            // Try the next browser-supported codec profile.
        }
    }
    throw new Error(`${format.toUpperCase()} WebCodecs encoding is not supported by this browser.`);
};

const exportWithWebCodecs = async (
    settings: ExportVideoSettings,
    firstFrame: ExportFrameCanvases,
    size: { width: number; height: number },
    frames: number[],
    getFrame: ExportFrameProvider,
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
) => {
    const { VideoEncoder, VideoFrame } = getWebCodecs();
    if (!VideoEncoder || !VideoFrame) {
        throw new Error('WebCodecs is not available.');
    }

    const bitrate = Math.max(4_000_000, size.width * size.height * settings.fps * 0.15);
    const codec = await selectWebCodecsConfig(settings.format, size.width, size.height, settings.fps, bitrate);
    const surface = createExportSurface(settings, firstFrame, size);
    const targetModule: any = settings.format === 'webm'
        ? await import('webm-muxer')
        : await import('mp4-muxer');
    const target = new targetModule.ArrayBufferTarget();
    const muxerOptions = settings.format === 'webm'
        ? {
              target,
              video: {
                  codec: codec.muxCodec,
                  width: size.width,
                  height: size.height,
                  frameRate: settings.fps,
              },
              firstTimestampBehavior: 'strict',
          }
        : {
              target,
              video: {
                  codec: codec.muxCodec,
                  width: size.width,
                  height: size.height,
                  frameRate: settings.fps,
              },
              fastStart: 'in-memory',
              firstTimestampBehavior: 'strict',
          };
    const muxer = new targetModule.Muxer(muxerOptions as any);
    let encoderError: unknown = null;
    const encoder = new VideoEncoder({
        output: (chunk: any, metadata: any) => muxer.addVideoChunk(chunk, metadata),
        error: (error: unknown) => {
            encoderError = error;
        },
    });
    encoder.configure(codec.config);

    const frameDuration = Math.round(1_000_000 / Math.max(1, settings.fps));
    try {
        for (let index = 0; index < frames.length; index += 1) {
            if (signal?.aborted) {
                throw new DOMException('Export cancelled.', 'AbortError');
            }
            if (encoderError) {
                throw encoderError;
            }
            const frame = index === 0 ? firstFrame : await getFrame(frames[index]);
            const canvas = updateExportSurface(surface, settings, frame);
            const videoFrame = new VideoFrame(canvas, {
                timestamp: index * frameDuration,
                duration: frameDuration,
            });
            try {
                encoder.encode(videoFrame, {
                    keyFrame: index === 0 || index % Math.max(1, settings.fps * 2) === 0,
                });
            } finally {
                videoFrame.close();
            }
            onProgress?.(index + 1, frames.length);
        }
        await encoder.flush();
        if (encoderError) {
            throw encoderError;
        }
        muxer.finalize();
    } finally {
        if (encoder.state !== 'closed') {
            encoder.close();
        }
    }

    const mimeType = settings.format === 'webm' ? 'video/webm' : 'video/mp4';
    downloadVideoBlob(new Blob([target.buffer], { type: mimeType }), settings);
};

const exportWithMediaRecorder = async (
    settings: ExportVideoSettings,
    firstFrame: ExportFrameCanvases,
    size: { width: number; height: number },
    frames: number[],
    getFrame: ExportFrameProvider,
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
) => {
    const mimeType = getSupportedMimeType(settings.format);
    const surface = createExportSurface(settings, firstFrame, size);
    const captureTarget = surface.direct ?? surface.staging;

    // This is a compatibility path only. MediaRecorder timestamps are based
    // on wall-clock capture time, so deterministic duration requires WebCodecs.
    let stream = captureTarget.captureStream(0);
    let track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    if (!track?.requestFrame) {
        stream.getTracks().forEach((streamTrack) => streamTrack.stop());
        stream = captureTarget.captureStream(Math.max(1, settings.fps));
        track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined;
    }
    const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: Math.max(4_000_000, size.width * size.height * settings.fps * 0.15),
    });
    const chunks: Blob[] = [];
    const dataPromise = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                chunks.push(event.data);
            }
        };
        recorder.onerror = () => reject(new Error('Video recording failed.'));
        recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    });

    try {
        recorder.start();
    } catch (error) {
        stream.getTracks().forEach((streamTrack) => streamTrack.stop());
        throw error;
    }

    let loopError: unknown = null;
    try {
        for (let index = 0; index < frames.length; index += 1) {
            if (signal?.aborted) {
                throw new DOMException('Export cancelled.', 'AbortError');
            }
            const frame = index === 0 ? firstFrame : await getFrame(frames[index]);
            updateExportSurface(surface, settings, frame);
            track?.requestFrame?.();
            onProgress?.(index + 1, frames.length);
            await wait(1000 / Math.max(1, settings.fps));
        }
    } catch (error) {
        loopError = error;
    } finally {
        if (recorder.state !== 'inactive') {
            recorder.stop();
        }
    }

    let blob: Blob;
    try {
        blob = await dataPromise;
    } finally {
        stream.getTracks().forEach((streamTrack) => streamTrack.stop());
    }
    if (loopError) {
        throw loopError;
    }
    if (signal?.aborted) {
        throw new DOMException('Export cancelled.', 'AbortError');
    }
    downloadVideoBlob(blob, settings);
};

export const exportVideo = async (
    settings: ExportVideoSettings,
    getFrame: ExportFrameProvider,
    onProgress?: (completed: number, total: number) => void,
    signal?: AbortSignal,
) => {
    if (settings.endFrame < settings.startFrame) {
        throw new Error('End frame must be greater than or equal to start frame.');
    }

    const firstFrame = await getFrame(settings.startFrame);
    const size = getCanvasSize(settings.source, firstFrame, settings.scale);
    const frames = buildFrameList(settings);
    if (canUseWebCodecs()) {
        await exportWithWebCodecs(settings, firstFrame, size, frames, getFrame, onProgress, signal);
        return;
    }
    if (!canUseMediaRecorder()) {
        throw new Error('This browser supports neither WebCodecs nor MediaRecorder canvas export.');
    }
    await exportWithMediaRecorder(settings, firstFrame, size, frames, getFrame, onProgress, signal);
};
