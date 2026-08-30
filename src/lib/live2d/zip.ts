/**
 * Minimal STORE-only ZIP writer/parser for the Live2D model format (M5).
 * No compression: vertex buffers and textures dominate, and skipping
 * deflate keeps this dependency-free and exactly round-trippable.
 */

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

export const crc32 = (data: Uint8Array) => {
    let crc = 0xffffffff;
    for (let index = 0; index < data.length; index += 1) {
        crc = CRC_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
};

const writeUint16 = (view: DataView, offset: number, value: number) => {
    view.setUint16(offset, value, true);
};

const writeUint32 = (view: DataView, offset: number, value: number) => {
    view.setUint32(offset, value, true);
};

export type ZipEntry = { name: string; data: Uint8Array };

export const createZip = (entries: ZipEntry[]): Uint8Array => {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;

    entries.forEach((entry) => {
        const nameBytes = encoder.encode(entry.name);
        const crc = crc32(entry.data);

        const localHeader = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(localHeader.buffer);
        writeUint32(localView, 0, 0x04034b50);
        writeUint16(localView, 4, 20); // version needed
        writeUint16(localView, 6, 0); // flags
        writeUint16(localView, 8, 0); // method: store
        writeUint16(localView, 10, 0); // mod time
        writeUint16(localView, 12, 0); // mod date
        writeUint32(localView, 14, crc);
        writeUint32(localView, 18, entry.data.length);
        writeUint32(localView, 22, entry.data.length);
        writeUint16(localView, 26, nameBytes.length);
        writeUint16(localView, 28, 0); // extra length
        localHeader.set(nameBytes, 30);

        chunks.push(localHeader, entry.data);

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(centralHeader.buffer);
        writeUint32(centralView, 0, 0x02014b50);
        writeUint16(centralView, 4, 20); // version made by
        writeUint16(centralView, 6, 20); // version needed
        writeUint16(centralView, 8, 0); // flags
        writeUint16(centralView, 10, 0); // method
        writeUint16(centralView, 12, 0);
        writeUint16(centralView, 14, 0);
        writeUint32(centralView, 16, crc);
        writeUint32(centralView, 20, entry.data.length);
        writeUint32(centralView, 24, entry.data.length);
        writeUint16(centralView, 28, nameBytes.length);
        writeUint16(centralView, 30, 0); // extra
        writeUint16(centralView, 32, 0); // comment
        writeUint16(centralView, 34, 0); // disk
        writeUint16(centralView, 36, 0); // internal attrs
        writeUint32(centralView, 38, 0); // external attrs
        writeUint32(centralView, 42, offset);
        centralHeader.set(nameBytes, 46);
        central.push(centralHeader);

        offset += localHeader.length + entry.data.length;
    });

    const centralSize = central.reduce((total, chunk) => total + chunk.length, 0);
    const endRecord = new Uint8Array(22);
    const endView = new DataView(endRecord.buffer);
    writeUint32(endView, 0, 0x06054b50);
    writeUint16(endView, 4, 0);
    writeUint16(endView, 6, 0);
    writeUint16(endView, 8, entries.length);
    writeUint16(endView, 10, entries.length);
    writeUint32(endView, 12, centralSize);
    writeUint32(endView, 16, offset);
    writeUint16(endView, 20, 0);

    const totalSize = offset + centralSize + endRecord.length;
    const output = new Uint8Array(totalSize);
    let cursor = 0;
    [...chunks, ...central, endRecord].forEach((chunk) => {
        output.set(chunk, cursor);
        cursor += chunk.length;
    });
    return output;
};

/** Parses STORE entries by scanning local file headers. */
export const parseZip = (buffer: Uint8Array): Map<string, Uint8Array> => {
    const decoder = new TextDecoder();
    const files = new Map<string, Uint8Array>();
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    let cursor = 0;
    while (cursor + 30 <= buffer.length) {
        if (view.getUint32(cursor, true) !== 0x04034b50) {
            break;
        }
        const method = view.getUint16(cursor + 8, true);
        if (method !== 0) {
            throw new Error(`Unsupported zip compression method ${method}; only STORE is allowed.`);
        }
        const compressedSize = view.getUint32(cursor + 18, true);
        const nameLength = view.getUint16(cursor + 26, true);
        const extraLength = view.getUint16(cursor + 28, true);
        const nameStart = cursor + 30;
        const dataStart = nameStart + nameLength + extraLength;
        const name = decoder.decode(buffer.subarray(nameStart, nameStart + nameLength));
        files.set(name, buffer.subarray(dataStart, dataStart + compressedSize));
        cursor = dataStart + compressedSize;
    }

    if (files.size === 0) {
        throw new Error('No zip entries found.');
    }
    return files;
};
