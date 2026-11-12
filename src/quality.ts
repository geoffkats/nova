export type QualityTier = 'high' | 'medium' | 'low';

export interface Quality {
  tier: QualityTier;
  faceParticles: number;
  haloParticles: number;
  dustParticles: number;
  dpr: [number, number];
  multisampling: number;
}

export const QUALITY: Record<QualityTier, Quality> = {
  // High keeps enough surface points for depth while preserving facial features.
  high: {
    tier: 'high',
    faceParticles: 2500,
    haloParticles: 800,
    dustParticles: 100,
    dpr: [1, 2],
    multisampling: 4,
  },
  // Everyday Nova — sharp silhouette, less mush.
  medium: {
    tier: 'medium',
    faceParticles: 1700,
    haloParticles: 600,
    dustParticles: 70,
    dpr: [1, 1.5],
    multisampling: 0,
  },
  low: {
    tier: 'low',
    faceParticles: 1100,
    haloParticles: 400,
    dustParticles: 50,
    dpr: [0.75, 1],
    multisampling: 0,
  },
};

/** Heuristic starting tier; PerformanceMonitor can still step it down at runtime. */
export function detectQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'medium';
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const mobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  if (cores <= 2 || memory <= 2) return 'low';
  if (mobile || cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}

export const stepDown = (tier: QualityTier): QualityTier => (tier === 'high' ? 'medium' : 'low');
