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
  // Mild baked asymmetry so the face doesn't read as a perfect mirror.
  const fxA = fx + 0.018;
  const ax = Math.abs(fxA);
  let d = 0;

  // Forehead plate (soft) + strong brow shelf that interrupts the dome.
  d += 0.02 * g2(fxA, fy, 0, 0.65, 0.48, 0.18);
  d += 0.085 * g2(fxA, fy, 0, 0.31, 0.4, 0.048); // brow ridge
  d += 0.03 * g2(ax, fy, 0.28, 0.28, 0.1, 0.04); // brow peaks

  // Eye sockets — deeper wells so irises feel seated.
  d -= 0.22 * g2(ax, fy, 0.34, 0.13, 0.115, 0.075);
  d -= 0.05 * g2(ax, fy, 0.34, 0.05, 0.14, 0.05); // infraorbital shelf
  d -= 0.04 * g2(ax, fy, 0.7, 0.28, 0.1, 0.14); // temples

  // Nose: bridge ridge → tip, under-tip drop, alar wings
  const ramp = smooth(0.22, -0.2, fy);
  const drop = 1 - smooth(-0.2, -0.3, fy);
  const width = 0.04 + 0.055 * smooth(0.1, -0.24, fy);
  d +=
    (0.035 + 0.26 * ramp * ramp) *
    drop *
    Math.exp(-(fxA * fxA) / (2 * width * width)) *
    smooth(0.38, 0.18, fy);
  // Sharp bridge crest (helps topo contours catch the ridge head-on).
  d += 0.04 * Math.exp(-(fxA * fxA) / (2 * 0.018 * 0.018)) * smooth(0.28, -0.05, fy) * smooth(-0.28, 0.05, fy);
  d += 0.055 * g2(ax, fy, 0.1, -0.24, 0.042, 0.032); // alae
  d -= 0.025 * g2(fxA, fy, 0, -0.28, 0.06, 0.025); // under-tip notch

  // Nasolabial folds — midface clarity (biggest anti-mush).
  d -= 0.045 * g2(ax, fy, 0.22, -0.32, 0.055, 0.12);
  d -= 0.028 * g2(ax, fy, 0.28, -0.22, 0.05, 0.08);

  // Philtrum, lips, mouth seam, mental groove, chin
  d -= 0.028 * g2(fxA, fy, 0, -0.34, 0.055, 0.04); // philtrum trench
  d += 0.06 * g2(fxA, fy, 0, -0.412, 0.16, 0.03); // upper lip
  d -= 0.04 * g2(fxA, fy, 0, -0.463, 0.18, 0.01); // seam
  d += 0.055 * g2(fxA, fy, 0, -0.512, 0.15, 0.03); // lower lip
  d -= 0.025 * g2(fxA, fy, 0, -0.6, 0.12, 0.028); // mental groove
  d += 0.1 * g2(fxA, fy, 0, -0.76, 0.15, 0.075); // chin pad

  // Cheekbones up, hollows below — planes of the face.
  d += 0.1 * g2(ax, fy, 0.48, -0.0, 0.11, 0.08);
  d -= 0.055 * g2(ax, fy, 0.42, -0.38, 0.13, 0.11);

  // Mandible corner / jaw angle (reads from ¾ view).
  d += 0.06 * g2(ax, fy, 0.58, -0.55, 0.08, 0.07);
  d += 0.035 * g2(ax, fy, 0.52, -0.68, 0.09, 0.06);

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
  const jawAngle = g2(Math.abs(fx), fy, 0.55, -0.58, 0.12, 0.1);
  // Ellipsoid already narrows toward the pole; counter it near the chin so the jaw stays broad.
  x *= (1 - 0.18 * Math.pow(jaw, 1.3)) * (1 + 0.22 * chinSquare) * (1 - 0.05 * crown);
  x *= 1 + 0.04 * jawAngle; // flare at mandible corners
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
  w += 1.45 * g2(ax, fy, 0.35, 0.14, 0.11, 0.075) * front; // eyes
  w += 0.7 * g2(fx, fy, 0, -0.05, 0.055, 0.2) * front; // nose bridge
  w += 1.45 * g2(fx, fy, 0, -0.46, 0.17, 0.06) * front; // mouth
  w += 0.35 * g2(ax, fy, 0.22, -0.32, 0.06, 0.1) * front; // nasolabial
  w += 0.18 * g2(ax, fy, 0.5, -0.02, 0.11, 0.09) * front; // cheekbones (light)
  w += 0.55 * g2(fx, fy, 0, -0.75, 0.18, 0.075) * front; // chin
  w += 0.95 * g2(fx, fy, 0, 0.31, 0.4, 0.05) * front; // brow shelf
  w += 0.95 * smooth(0.5, 0.9, ax) * smooth(0.05, -0.6, fy) * front; // jawline
  w += 0.4 * g2(ax, fy, 0.58, -0.55, 0.08, 0.07) * front; // jaw angle
  // Soften forehead / temples so they don't fill into a solid plate.
  w *= 1 - 0.5 * smooth(0.48, 0.95, fy) * front;
  return w;
}
