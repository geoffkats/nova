import * as THREE from 'three';

/**
 * Procedural head field.
 * The head is a deformed ellipsoid parameterised by longitude `u` (0 = facing +Z / camera)
 * and latitude `v`. Facial anatomy is sculpted with anisotropic Gaussian displacements
 * expressed in normalised "face coordinates" (fx, fy) in roughly [-1, 1].
 */

export const HEAD = { rx: 0.73, ry: 1.0, rz: 0.88 };
export const U_RANGE: [number, number] = [-2.45, 2.45];
export const V_RANGE: [number, number] = [-1.32, 1.5];

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const g2 = (x: number, y: number, cx: number, cy: number, sx: number, sy: number) =>
  Math.exp(-(((x - cx) ** 2) / (2 * sx * sx) + ((y - cy) ** 2) / (2 * sy * sy)));

/** Forward (z) relief of the face at normalised coordinates. */
function relief(fx: number, fy: number): number {
  const ax = Math.abs(fx);
  let d = 0;

  // Forehead & brow ridge
  d += 0.035 * g2(fx, fy, 0, 0.62, 0.5, 0.2);
  d += 0.05 * g2(fx, fy, 0, 0.3, 0.42, 0.055);

  // Eye sockets & temples
  d -= 0.16 * g2(ax, fy, 0.34, 0.13, 0.12, 0.08);
  d -= 0.035 * g2(ax, fy, 0.68, 0.3, 0.1, 0.15);

  // Nose: bridge → tip, then under-tip drop, plus alar wings
  const ramp = smooth(0.22, -0.2, fy);
  const drop = 1 - smooth(-0.2, -0.3, fy);
  const width = 0.045 + 0.06 * smooth(0.1, -0.24, fy);
  d +=
    (0.03 + 0.21 * ramp * ramp) *
    drop *
    Math.exp(-(fx * fx) / (2 * width * width)) *
    smooth(0.36, 0.2, fy);
  d += 0.045 * g2(ax, fy, 0.1, -0.24, 0.045, 0.035);

  // Philtrum, lips, mouth seam, mental groove, chin
  d -= 0.02 * g2(fx, fy, 0, -0.34, 0.1, 0.035);
  d += 0.05 * g2(fx, fy, 0, -0.415, 0.17, 0.032);
  d -= 0.035 * g2(fx, fy, 0, -0.463, 0.19, 0.011);
  d += 0.045 * g2(fx, fy, 0, -0.51, 0.15, 0.032);
  d -= 0.02 * g2(fx, fy, 0, -0.6, 0.13, 0.03);
  d += 0.09 * g2(fx, fy, 0, -0.76, 0.16, 0.08);

  // Cheekbones & cheek hollows
  d += 0.08 * g2(ax, fy, 0.5, -0.02, 0.12, 0.09);
  d -= 0.03 * g2(ax, fy, 0.47, -0.36, 0.12, 0.12);

  return d;
}

export function headPoint(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const cv = Math.cos(v);
  const su = Math.sin(u);
  const cu = Math.cos(u);

  // Face coordinates come from the undeformed sphere so features stay anchored.
  const fx = cv * su;
  const fy = Math.sin(v);

  let x = HEAD.rx * cv * su;
  const y = HEAD.ry * fy;
  let z = HEAD.rz * cv * cu;

  // Skull: fuller cranium at the back, tapering jaw below the cheekbones.
  // Flatter crown, wider temples, angular jaw narrowing toward a defined chin.
  const crown = smooth(0.55, 1.0, fy);
  const jaw = smooth(-0.3, -1.0, fy);
  const chinSquare = smooth(-0.78, -1.0, fy);
  // Ellipsoid already narrows toward the pole; counter it near the chin so the jaw stays broad.
  x *= (1 - 0.2 * Math.pow(jaw, 1.3)) * (1 + 0.2 * chinSquare) * (1 - 0.05 * crown);
  if (z < 0) {
    z *= fy > 0 ? 1.1 : 1 - 0.55 * jaw;
  }

  const front = smooth(0.15, 0.85, cu);
  z += relief(fx, fy) * front;

  return out.set(x, y, z);
}

/** Position on the face surface for normalised face coordinates. */
export function facePoint(fx: number, fy: number, out = new THREE.Vector3()): THREE.Vector3 {
  const v = Math.asin(clamp(fy, -0.999, 0.999));
  const u = Math.asin(clamp(fx / Math.cos(v), -0.999, 0.999));
  return headPoint(u, v, out);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
export function headNormal(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 1e-3;
  headPoint(u, v, _c);
  headPoint(u + e, v, _a).sub(_c);
  headPoint(u, v + e, _b).sub(_c);
  return out.crossVectors(_a, _b).normalize();
}

/** Indexed surface mesh of the head. */
export function buildHeadSurface(segU: number, segV: number): THREE.BufferGeometry {
  const count = (segU + 1) * (segV + 1);
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const p = new THREE.Vector3();
  let i = 0;
  for (let iv = 0; iv <= segV; iv++) {
    const v = THREE.MathUtils.lerp(V_RANGE[0], V_RANGE[1], iv / segV);
    for (let iu = 0; iu <= segU; iu++) {
      const u = THREE.MathUtils.lerp(U_RANGE[0], U_RANGE[1], iu / segU);
      headPoint(u, v, p);
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      uvs[i * 2] = iu / segU;
      uvs[i * 2 + 1] = iv / segV;
      i++;
    }
  }
  const index: number[] = [];
  const row = segU + 1;
  for (let iv = 0; iv < segV; iv++) {
    for (let iu = 0; iu < segU; iu++) {
      const a = iv * row + iu;
      index.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/** Contour-style line lattice: horizontal scan contours plus sparse meridians. */
export function buildHeadLattice(rows: number, cols: number, samples: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const push = (u: number, v: number) => {
    headPoint(u, v, p);
    headNormal(u, v, n);
    p.addScaledVector(n, 0.004); // lift off the surface to avoid shimmer
    pos.push(p.x, p.y, p.z);
    nor.push(n.x, n.y, n.z);
  };
  for (let r = 0; r <= rows; r++) {
    const v = THREE.MathUtils.lerp(V_RANGE[0] + 0.05, V_RANGE[1] - 0.08, r / rows);
    for (let s = 0; s < samples; s++) {
      push(THREE.MathUtils.lerp(U_RANGE[0], U_RANGE[1], s / samples), v);
      push(THREE.MathUtils.lerp(U_RANGE[0], U_RANGE[1], (s + 1) / samples), v);
    }
  }
  for (let c = 0; c <= cols; c++) {
    const u = THREE.MathUtils.lerp(U_RANGE[0] + 0.1, U_RANGE[1] - 0.1, c / cols);
    for (let s = 0; s < samples; s++) {
      push(u, THREE.MathUtils.lerp(V_RANGE[0], V_RANGE[1], s / samples));
      push(u, THREE.MathUtils.lerp(V_RANGE[0], V_RANGE[1], (s + 1) / samples));
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return geo;
}

/** Density weighting so particles cluster on the features that make it read as a face. */
export function featureWeight(u: number, v: number): number {
  const cv = Math.cos(v);
  const fx = cv * Math.sin(u);
  const fy = Math.sin(v);
  const ax = Math.abs(fx);
  const front = smooth(-0.2, 0.9, Math.cos(u));
  // Sparse cheeks / crown — density lives on eyes, mouth, brow, jaw silhouette.
  let w = 0.02 + 0.1 * front;
  w += 1.35 * g2(ax, fy, 0.35, 0.14, 0.11, 0.075) * front; // eyes
  w += 0.55 * g2(fx, fy, 0, -0.05, 0.06, 0.2) * front; // nose bridge
  w += 1.4 * g2(fx, fy, 0, -0.46, 0.18, 0.065) * front; // mouth
  w += 0.22 * g2(ax, fy, 0.5, -0.02, 0.11, 0.09) * front; // cheekbones (light)
  w += 0.55 * g2(fx, fy, 0, -0.75, 0.18, 0.075) * front; // chin
  w += 0.7 * g2(fx, fy, 0, 0.3, 0.42, 0.055) * front; // brow
  w += 0.85 * smooth(0.52, 0.88, ax) * smooth(0.05, -0.55, fy) * front; // jawline
  // Soften forehead / temples so they don't fill into a solid plate.
  w *= 1 - 0.45 * smooth(0.45, 0.95, fy) * front;
  return w;
}
