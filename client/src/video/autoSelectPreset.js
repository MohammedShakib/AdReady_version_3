import { VIDEO_PRESET_MODES } from './presets';

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

const containsAnyToken = (haystack, tokens) =>
  tokens.some((token) => haystack.includes(token));

export const resolveAutoPresetFromMeta = (meta = {}) => {
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

  if (containsAnyToken(mergedText, PREMIUM_TOKENS)) {
    return VIDEO_PRESET_MODES.PREMIUM;
  }
  if (containsAnyToken(mergedText, BOLD_TOKENS)) {
    return VIDEO_PRESET_MODES.BOLD;
  }

  return VIDEO_PRESET_MODES.SMOOTH;
};
