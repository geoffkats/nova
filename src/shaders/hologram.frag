uniform float uTime;
uniform float uFlow;       // energy clock; runs faster while thinking or speaking
uniform float uIntensity;
uniform float uOpacity;
uniform float uScanSpeed;
uniform float uNoiseStrength;
uniform float uFresnelPower;
uniform float uReveal;     // 0 → 1 startup materialisation
uniform float uLineMode;   // 0 = surface, 1 = contour lattice
uniform vec3 uColor;
uniform vec3 uHighlight;

varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vObjPos;
varying vec3 vWorldPos;

float hash31(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i + vec3(0, 0, 0)), hash31(i + vec3(1, 0, 0)), f.x),
        mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), f.x),
        mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}

float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 n = normalize(vNormalV);
  vec3 viewDir = normalize(vViewDir);
  float facing = abs(dot(n, viewDir));
  float fresnel = pow(1.0 - facing, uFresnelPower);

  float t = uTime;
  // Feature mask in object space — eyes / nose / mouth / brow get cleaner signal.
  float eyeL = exp(-pow((vObjPos.x + 0.26) * 9.0, 2.0) - pow((vObjPos.y - 0.12) * 11.0, 2.0));
  float eyeR = exp(-pow((vObjPos.x - 0.26) * 9.0, 2.0) - pow((vObjPos.y - 0.12) * 11.0, 2.0));
  float noseM = exp(-pow(vObjPos.x * 14.0, 2.0) - pow((vObjPos.y + 0.02) * 5.5, 2.0));
  float mouthM = exp(-pow(vObjPos.x * 7.0, 2.0) - pow((vObjPos.y + 0.42) * 10.0, 2.0));
  float browM = exp(-pow(vObjPos.x * 3.2, 2.0) - pow((vObjPos.y - 0.28) * 14.0, 2.0));
  float feature = clamp(eyeL + eyeR + noseM * 1.1 + mouthM + browM * 0.9, 0.0, 1.0);
  float featureQuiet = 1.0 - feature * 0.72; // scan/noise quieter on anatomy

  float nz = fbm(vObjPos * 3.2 + vec3(0.0, t * 0.12, t * 0.05));
  nz = mix(nz, 0.5, feature * 0.55); // less grain on features

  // Scanlines: fine interference + sweep; dialed down on features.
  float fine = pow(0.5 + 0.5 * sin(vWorldPos.y * 150.0 - t * uScanSpeed * 7.0), 8.0) * featureQuiet;
  float sweep = 0.65 + 0.35 * sin(vWorldPos.y * 7.0 - t * uScanSpeed);

  // Energy band travelling up the face, and a slower one going down.
  float bandUp = exp(-pow((vObjPos.y - (fract(uFlow * 0.11) * 3.4 - 1.7)) * 8.0, 2.0));
  float bandDn = exp(-pow((vObjPos.y - (1.7 - fract(uFlow * 0.043 + 0.4) * 3.4)) * 14.0, 2.0)) * 0.6;
  float energy = (bandUp + bandDn) * (0.55 + 0.45 * nz) * mix(1.0, 0.65, feature);

  // Subtle flicker.
  float flicker = 0.95 + 0.05 * sin(t * 41.0) * sin(t * 17.3 + 1.7);

  // Dissolve toward the back of the skull and below the jaw.
  float back = smoothstep(-0.55, 0.3, vObjPos.z + (nz - 0.5) * 0.7);
  float bottom = smoothstep(-1.0, -0.5, vObjPos.y + (nz - 0.5) * 0.45);
  // Patchy transparency so parts of the surface give way to particles.
  float patches = mix(0.35, 1.0, smoothstep(0.32, 0.68, nz));

  // Startup reveal grows outward from the centre of the face.
  float field = length(vObjPos.xy * vec2(1.2, 0.85)) * 0.75 + nz * 0.45 + max(-vObjPos.z, 0.0) * 0.4;
  float threshold = uReveal * 1.45 - 0.05;
  float reveal = smoothstep(threshold, threshold - 0.1, field);
  float burn = exp(-pow((field - threshold) * 45.0, 2.0)) * (0.5 + 0.5 * step(0.55, nz)) * (1.0 - smoothstep(0.85, 1.0, uReveal));

  // Topographic depth contours — denser where depth changes (ridges / folds).
  float depthK = vObjPos.z * 32.0 + vObjPos.y * 1.6;
  float cw = fwidth(depthK);
  float distToLine = 0.5 - abs(fract(depthK) - 0.5);
  float contour = 1.0 - smoothstep(0.0, cw * 1.25, distToLine);
  contour *= smoothstep(-0.1, 0.45, vObjPos.z);
  // Boost contours on nose / midface so the ridge reads head-on.
  contour *= 1.0 + noseM * 0.85 + feature * 0.25;

  // Soft key light from upper-left so planes of the face separate.
  float key = pow(max(dot(n, normalize(vec3(-0.45, 0.55, 0.7))), 0.0), 2.0);

  // Valley darkening: hollows / sockets face less camera → dim (face clarity).
  // Ridges (high fresnel / high z facing) stay bright — hologram energy on edges.
  float valley = pow(facing, 1.35); // 1 = facing camera flat, lower in recesses
  float ridge = fresnel;
  float formGain = mix(0.42, 1.15, valley) * (0.85 + ridge * 0.45);

  float surfaceA = 0.01 + fresnel * 0.72 + fine * 0.04 + energy * 0.18 + contour * 0.5 * (0.55 + 0.45 * sweep) + key * 0.08;
  float lineA = 0.14 + fresnel * 0.55 + fine * 0.1 + energy * 0.65;
  float alpha = mix(surfaceA, lineA, uLineMode);
  alpha *= formGain;
  alpha *= back * bottom * mix(patches, 1.0, uLineMode * 0.4) * sweep * flicker;
  alpha = alpha * reveal + burn * 0.35 * back * bottom;
  alpha *= uOpacity;

  vec3 color = mix(uColor, uHighlight, clamp(fresnel * 0.5 + energy * 0.5 + burn + contour * 0.15, 0.0, 1.0));
  // Dim color in valleys so additive stack doesn't wash the face.
  color *= mix(0.55, 1.08, valley);
  color *= uIntensity * (1.0 + (nz - 0.5) * uNoiseStrength * 0.28 * featureQuiet);

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
