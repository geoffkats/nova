import { useEffect, useMemo, type MutableRefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { AvatarState } from '../hooks/useAvatarAnimation';
import { HOLO_CYAN, HOLO_WHITE } from './palette';

interface Props {
  stateRef: MutableRefObject<AvatarState>;
}

function orbitGeometry(radius: number, squash: number, tilt: THREE.Euler) {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i < 96; i++) {
    const t = (i / 96) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(t) * radius, Math.sin(t) * radius * squash, 0).applyEuler(tilt));
  }
  const curve = new THREE.CatmullRomCurve3(points, true);
  return new THREE.TubeGeometry(curve, 192, 0.0035, 4, true);
}

export function ScienceMotifs({ stateRef }: Props) {
  const field = useMemo(() => {
    const group = new THREE.Group();
    // Keep the quantum field just outside the temple so it frames the face.
    group.position.set(-0.98, 0.2, 0.12);
    const materials: THREE.MeshBasicMaterial[] = [];
    const orbits = [
      { radius: 0.31, squash: 0.58, tilt: new THREE.Euler(0.35, 0.1, 0.6) },
      { radius: 0.37, squash: 0.46, tilt: new THREE.Euler(0.62, 1.05, 0.38) },
      { radius: 0.33, squash: 0.7, tilt: new THREE.Euler(0.45, 2, 0.2) },
    ];
    for (const [i, orbit] of orbits.entries()) {
      const material = new THREE.MeshBasicMaterial({
        color: i === 1 ? HOLO_WHITE : HOLO_CYAN,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      materials.push(material);
      group.add(new THREE.Mesh(orbitGeometry(orbit.radius, orbit.squash, orbit.tilt), material));
    }
    const beadMaterial = new THREE.MeshBasicMaterial({
      color: HOLO_WHITE,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    materials.push(beadMaterial);
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), beadMaterial);
    group.add(bead);
    return { group, materials, bead };
  }, []);

  useEffect(
    () => () => {
      field.group.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      field.materials.forEach((material) => material.dispose());
    },
    [field],
  );

  useFrame((_, delta) => {
    const s = stateRef.current;
    const reveal = THREE.MathUtils.smoothstep(s.rings, 0.35, 0.8);
    const intensity = reveal * s.modes.thinking * 0.38;
    field.materials.forEach((material, index) => {
      material.opacity = intensity * (index === 3 ? 0.8 : 0.55);
    });
    field.group.rotation.z += delta * (0.14 + s.modes.thinking * 0.24);
    field.group.rotation.y = Math.sin(s.time * 0.3) * 0.08;
    const phase = s.time * (0.5 + s.modes.thinking * 0.45);
    field.bead.position.set(Math.cos(phase) * 0.31, Math.sin(phase) * 0.18, Math.sin(phase * 0.5) * 0.08);
  });

  return <primitive object={field.group} renderOrder={5} />;
}
