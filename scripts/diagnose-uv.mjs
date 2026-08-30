// Diagnoses the uv corruption in an exported moc3: per drawable, NaN/garbage
// census + affine fit of (file uv) ~ (neutral position) over the sane ones.
// Usage: node scripts/diagnose-uv.mjs <model.moc3>
import { readMoc3 } from './moc3-reader.mjs';

const m = readMoc3(process.argv[2]);
const sane = [];
m.am.ids.forEach((id2, i) => {
    const n = m.am.vertexCounts[i];
    const uv = m.uvs[i];
    let bad = 0;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (let v = 0; v < n * 2; v += 2) {
        const ok = Number.isFinite(uv[v]) && Number.isFinite(uv[v + 1])
            && Math.abs(uv[v]) < 10 && Math.abs(uv[v + 1]) < 10;
        if (!ok) {
            bad += 1;
            continue;
        }
        u0 = Math.min(u0, uv[v]); u1 = Math.max(u1, uv[v]);
        v0 = Math.min(v0, uv[v + 1]); v1 = Math.max(v1, uv[v + 1]);
    }
    const status = bad === 0 ? 'SANE' : (bad === n ? 'ALL-BAD' : `bad=${bad}/${n}`);
    if (bad === 0) sane.push(i);
    console.log(String(i).padStart(2), id2.padEnd(10), status.padEnd(12),
        bad === 0 ? `u[${u0.toFixed(3)},${u1.toFixed(3)}] v[${v0.toFixed(3)},${v1.toFixed(3)}]` : '');
});

// Affine fit uv = a*x + b*y + c on sane drawables (positions in file units).
const fit = (P, ys) => {
    let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, S1 = 0, Sxy2 = 0, Sx2 = 0, Sy2 = 0;
    P.forEach(([x, y], k) => {
        Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; S1 += 1;
        Sxy2 += x * ys[k]; Sx2 += y * ys[k]; Sy2 += ys[k];
    });
    const M = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, S1]];
    const rhs = [Sxy2, Sx2, Sy2];
    for (let cc = 0; cc < 3; cc += 1) {
        let piv = cc;
        for (let r = cc + 1; r < 3; r += 1) if (Math.abs(M[r][cc]) > Math.abs(M[piv][cc])) piv = r;
        [M[cc], M[piv]] = [M[piv], M[cc]];
        [rhs[cc], rhs[piv]] = [rhs[piv], rhs[cc]];
        for (let r = cc + 1; r < 3; r += 1) {
            const f = M[r][cc] / M[cc][cc];
            for (let c2 = cc; c2 < 3; c2 += 1) M[r][c2] -= f * M[cc][c2];
            rhs[r] -= f * rhs[cc];
        }
    }
    const sol = [0, 0, 0];
    for (let r = 2; r >= 0; r -= 1) {
        let s = rhs[r];
        for (let c2 = r + 1; c2 < 3; c2 += 1) s -= M[r][c2] * sol[c2];
        sol[r] = s / M[r][r];
    }
    let maxErr = 0;
    P.forEach(([x, y], k) => {
        maxErr = Math.max(maxErr, Math.abs(sol[0] * x + sol[1] * y + sol[2] - ys[k]));
    });
    return { sol, maxErr };
};

console.log('\n== affine fit on sane drawables: file_uv ~ neutral_position ==');
sane.forEach((i) => {
    const n = m.am.vertexCounts[i];
    const pos = m.neutralPositions[i];
    const uv = m.uvs[i];
    const P = [];
    const U = [];
    const V = [];
    for (let v = 0; v < n; v += 1) {
        P.push([pos[v * 2], pos[v * 2 + 1]]);
        U.push(uv[v * 2]);
        V.push(uv[v * 2 + 1]);
    }
    const fu = fit(P, U);
    const fv = fit(P, V);
    console.log(m.am.ids[i].padEnd(10),
        `u = ${fu.sol.map((v) => v.toFixed(4)).join(' * + ')}  maxErr=${fu.maxErr.toFixed(5)}`,
        `| v = ${fv.sol.map((v) => v.toFixed(4)).join(' * + ')}  maxErr=${fv.maxErr.toFixed(5)}`);
});

// Neutral position bbox per drawable, in atlas-ish pixel terms (units * ppu).
console.log('\n== neutral bbox (file units, y-down) ==');
m.am.ids.forEach((id2, i) => {
    const n = m.am.vertexCounts[i];
    const pos = m.neutralPositions[i];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let v = 0; v < n; v += 1) {
        x0 = Math.min(x0, pos[v * 2]); x1 = Math.max(x1, pos[v * 2]);
        y0 = Math.min(y0, pos[v * 2 + 1]); y1 = Math.max(y1, pos[v * 2 + 1]);
    }
    console.log(String(i).padStart(2), id2.padEnd(10),
        `x[${x0.toFixed(3)},${x1.toFixed(3)}] y[${y0.toFixed(3)},${y1.toFixed(3)}]`,
        `size=${((x1 - x0) * m.canvas.ppu).toFixed(0)}x${((y1 - y0) * m.canvas.ppu).toFixed(0)}px`);
});
