uniform float uTime;
uniform float uNoiseStrength;
uniform float uGlitch;

varying vec3 vNormalV;
varying vec3 vViewDir;
varying vec3 vObjPos;
varying vec3 vWorldPos;

float hash11(float n) { return fract(sin(n) * 43758.5453123); }

void main() {
  vec3 p = position;

  // Holographic distortion: thin horizontal slices occasionally slip sideways.
  float slice = floor(p.y * 26.0);
  float tick = floor(uTime * 9.0);
  float slip = hash11(slice * 13.7 + tick) - 0.5;
  slip *= step(0.93, hash11(slice + tick * 1.31)); // only a few slices at a time
  p.x += slip * 0.05 * uGlitch;

  // Very gentle surface undulation along the normal.
  p += normal * sin(p.y * 17.0 + uTime * 1.2) * 0.0025 * uNoiseStrength;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vViewDir = normalize(-mv.xyz);
  vNormalV = normalize(normalMatrix * normal);
  vObjPos = position;
  vWorldPos = (modelMatrix * vec4(p, 1.0)).xyz;
  gl_Position = projectionMatrix * mv;
}
