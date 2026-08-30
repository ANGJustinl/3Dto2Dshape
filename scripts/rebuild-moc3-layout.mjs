// Dev tool: re-lays-out a moc3 written by our older writer into the
// canonical Cubism layout (64-aligned placement, 128-byte count table,
// byte-sized drawableFlags), keeping all section data identical.
// Usage: node scripts/rebuild-moc3-layout.mjs <in.moc3> <out.moc3>
import { readFileSync, writeFileSync } from 'node:fs';

const input = readFileSync(process.argv[2]);
const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
const u32 = (o) => view.getUint32(o, true);

const counts = Array.from({ length: 23 }, (_, i) => u32(0x7c0 + i * 4));
const FIELDS = { parts:0, deformers:1, warp:2, rotation:3, artMeshes:4, parameters:5, partKeyforms:6, warpKf:7, rotKf:8, amKf:9, kfPos:10, pbi:11, kb:12, pb:13, keys:14, uvs:15, posIdx:16, masks:17, groups:18, gObj:19, glue:20, glueInfo:21, glueKf:22 };

// [slot, countField, bytesPerCount, kind] — kind 'ids' follows its runtime.
const LAYOUT = [
  [0, null, 128], [1, null, 64],
  [2, 'parts', 8, 'rt'], [3, 'parts', 64, 'ids'],
  [4,'parts',4],[5,'parts',4],[6,'parts',4],[7,'parts',4],[8,'parts',4],[9,'parts',4],
  [10, 'deformers', 8, 'rt'], [11, 'deformers', 64, 'ids'],
  [12,'deformers',4],[13,'deformers',4],[14,'deformers',4],[15,'deformers',4],[16,'deformers',4],[17,'deformers',4],[18,'deformers',4],
  [19,'warp',4],[20,'warp',4],[21,'warp',4],[22,'warp',4],[23,'warp',4],[24,'warp',4],
  [25,'rotation',4],[26,'rotation',4],[27,'rotation',4],[28,'rotation',4],
  [29,'artMeshes',8,'rt'],[30,'artMeshes',8,'rt'],[31,'artMeshes',8,'rt'],[32,'artMeshes',8,'rt'],
  [33, 'artMeshes', 64, 'ids'],
  [34,'artMeshes',4],[35,'artMeshes',4],[36,'artMeshes',4],[37,'artMeshes',4],[38,'artMeshes',4],[39,'artMeshes',4],[40,'artMeshes',4],[41,'artMeshes',4],[42,'artMeshes',1],[43,'artMeshes',4],[44,'artMeshes',4],[45,'artMeshes',4],[46,'artMeshes',4],[47,'artMeshes',4],[48,'artMeshes',4],
  [49, 'parameters', 8, 'rt'], [50, 'parameters', 64, 'ids'],
  [51,'parameters',4],[52,'parameters',4],[53,'parameters',4],[54,'parameters',4],[55,'parameters',4],[56,'parameters',4],[57,'parameters',4],
  [58,'partKeyforms',4],
  [59,'warpKf',4],[60,'warpKf',4],
  [61,'rotKf',4],[62,'rotKf',4],[63,'rotKf',4],[64,'rotKf',4],[65,'rotKf',4],[66,'rotKf',4],[67,'rotKf',4],
  [68,'amKf',4],[69,'amKf',4],[70,'amKf',4],
  [71,'kfPos',4],[72,'pbi',4],
  [73,'kb',4],[74,'kb',4],
  [75,'pb',4],[76,'pb',4],
  [77,'keys',4],[78,'uvs',4],[79,'posIdx',2],[80,'masks',4],
  [81,'groups',4],[82,'groups',4],[83,'groups',4],[84,'groups',4],[85,'groups',4],
  [86,'gObj',4],[87,'gObj',4],[88,'gObj',4],
  [89,'glue',8,'rt'],[90,'glue',64,'ids'],
  [91,'glue',4],[92,'glue',4],[93,'glue',4],[94,'glue',4],[95,'glue',4],[96,'glue',4],[97,'glue',4],
  [98,'glueInfo',4],[99,'glueInfo',4],
  [100,'glueKf',4],
];

const align64 = (v) => Math.ceil(v / 64) * 64;
let cursor = 0x7c0;
const plan = LAYOUT.map(([slot, field, bytes, kind]) => {
  if (kind !== 'ids') cursor = align64(cursor);
  const target = cursor;
  const count = field === null ? null : counts[FIELDS[field]];
  const size = field === null ? bytes : count * bytes;
  cursor += size;
  return { slot, target, size, field, bytes, kind, count };
});

const totalSize = align64(cursor);
const out = Buffer.alloc(totalSize);
input.subarray(0, 0x40).copy(out, 0);
plan.forEach(({ slot, target, size, field, bytes, kind, count }) => {
  out.writeUInt32LE(target, 0x40 + slot * 4);
  if (slot === 0) {
    input.subarray(u32(0x40), u32(0x40) + 92).copy(out, target);
    return;
  }
  if (slot === 1) {
    input.subarray(u32(0x44), u32(0x44) + 64).copy(out, target);
    return;
  }
  if (field === null || count === 0) {
    return; // empty sections have no data
  }
  const oldTarget = u32(0x40 + slot * 4);
  if (slot === 42) {
    // drawableFlags was stored u32-per-artmesh; canonical is one byte each.
    for (let i = 0; i < count; i++) {
      out[target + i] = input[oldTarget + i * 4];
    }
    return;
  }
  void bytes;
  void kind;
  input.subarray(oldTarget, oldTarget + size).copy(out, target);
});

writeFileSync(process.argv[3], out);
console.log(`rebuilt: ${input.length} -> ${out.length} bytes (${plan.filter((p) => p.count === null || p.count > 0).length} non-empty sections)`);
