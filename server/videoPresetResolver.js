const VIDEO_PRESET_MODES = Object.freeze({
  AUTO: 'auto',
  SMOOTH: 'smooth',
  BOLD: 'bold',
  PREMIUM: 'premium',
});

const MANUAL_PRESET_VALUES = new Set([
  VIDEO_PRESET_MODES.SMOOTH,
  VIDEO_PRESET_MODES.BOLD,
  VIDEO_PRESET_MODES.PREMIUM,
]);

const PREMIUM_TOKENS = [
  'premium',
  'luxury',
  'cinematic',
  'elegant',
  'noir',
  'fragrance',
  'perfume',
  'gold',
  'high-end',
  'sophisticated',
];

const BOLD_TOKENS = [
  'bold',
  'energetic',
  'action',
  'sport',
  'electric',
  'dynamic',
  'impact',
  'neon',
  'power',
  'fast',
  'tech',
];

const includesAnyToken = (haystack, tokens) => tokens.some((token) => haystack.includes(token));

const resolveAutoPresetFromMeta = (meta = {}) => {
  const mergedText = [
    meta?.visualMood,
    meta?.productName,
    meta?.extraNotes,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (!mergedText) {
    return VIDEO_PRESET_MODES.SMOOTH;
  }

  if (includesAnyToken(mergedText, PREMIUM_TOKENS)) {
    return VIDEO_PRESET_MODES.PREMIUM;
  }
  if (includesAnyToken(mergedText, BOLD_TOKENS)) {
    return VIDEO_PRESET_MODES.BOLD;
  }
  return VIDEO_PRESET_MODES.SMOOTH;
};

const resolveFinalPreset = ({ presetMode, meta = {} }) => {
  const normalizedMode = String(presetMode || VIDEO_PRESET_MODES.AUTO).trim().toLowerCase();
  if (MANUAL_PRESET_VALUES.has(normalizedMode)) {
    return normalizedMode;
  }
  return resolveAutoPresetFromMeta(meta);
};

module.exports = {
  VIDEO_PRESET_MODES,
  MANUAL_PRESET_VALUES,
  resolveAutoPresetFromMeta,
  resolveFinalPreset,
};
