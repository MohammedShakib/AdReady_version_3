export const VIDEO_PRESET_MODES = Object.freeze({
  AUTO: 'auto',
  SMOOTH: 'smooth',
  BOLD: 'bold',
  PREMIUM: 'premium',
});

export const VIDEO_PRESET_OPTIONS = Object.freeze([
  { value: VIDEO_PRESET_MODES.AUTO, label: 'Auto' },
  { value: VIDEO_PRESET_MODES.SMOOTH, label: 'Smooth' },
  { value: VIDEO_PRESET_MODES.BOLD, label: 'Bold' },
  { value: VIDEO_PRESET_MODES.PREMIUM, label: 'Premium' },
]);

export const VIDEO_PRESET_CONFIG = Object.freeze({
  [VIDEO_PRESET_MODES.SMOOTH]: {
    id: VIDEO_PRESET_MODES.SMOOTH,
    label: 'Smooth',
    heroScaleFrom: 1.0,
    heroScaleTo: 1.08,
    introFadeFrames: 18,
    textFadeFrames: 16,
    ctaDelayFrames: 136,
    accentStrength: 0.2,
    motionStyle: 'ease',
  },
  [VIDEO_PRESET_MODES.BOLD]: {
    id: VIDEO_PRESET_MODES.BOLD,
    label: 'Bold',
    heroScaleFrom: 1.03,
    heroScaleTo: 1.16,
    introFadeFrames: 10,
    textFadeFrames: 10,
    ctaDelayFrames: 124,
    accentStrength: 0.45,
    motionStyle: 'snappy',
  },
  [VIDEO_PRESET_MODES.PREMIUM]: {
    id: VIDEO_PRESET_MODES.PREMIUM,
    label: 'Premium',
    heroScaleFrom: 1.0,
    heroScaleTo: 1.1,
    introFadeFrames: 20,
    textFadeFrames: 18,
    ctaDelayFrames: 142,
    accentStrength: 0.3,
    motionStyle: 'elegant',
  },
});

export const MANUAL_VIDEO_PRESET_VALUES = new Set([
  VIDEO_PRESET_MODES.SMOOTH,
  VIDEO_PRESET_MODES.BOLD,
  VIDEO_PRESET_MODES.PREMIUM,
]);
