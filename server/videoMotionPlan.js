const clampNumber = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
};

const sanitizeText = (value, maxLength = 120) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const includesAny = (text, tokens) => tokens.some((token) => text.includes(token));

const PREMIUM_TOKENS = [
  'premium',
  'luxury',
  'cinematic',
  'elegant',
  'noir',
  'fragrance',
  'perfume',
  'gold',
  'sophisticated',
];

const BOLD_TOKENS = [
  'bold',
  'energetic',
  'dynamic',
  'action',
  'splash',
  'sport',
  'power',
  'electric',
  'neon',
  'impact',
  'fast',
];

const isGenericProductName = (productName) => {
  const normalized = String(productName || '').trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return (
    normalized === 'premium product hero' ||
    normalized === 'product hero' ||
    normalized === 'product'
  );
};

const pickPresetSuggestion = (analysis) => {
  const moodText = [
    analysis?.visualMood,
    analysis?.productName,
    analysis?.dynamicElements,
    analysis?.backgroundStyle,
    analysis?.extraNotes,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  if (!moodText) {
    return 'smooth';
  }
  if (includesAny(moodText, PREMIUM_TOKENS)) {
    return 'premium';
  }
  if (includesAny(moodText, BOLD_TOKENS)) {
    return 'bold';
  }
  return 'smooth';
};

const buildMotionPlanFromGeminiAnalysis = (analysis = {}) => {
  const presetSuggestion = pickPresetSuggestion(analysis);
  const cameraAngle = String(analysis?.cameraAngle || '').trim().toLowerCase();
  const lightingFocus = String(analysis?.lightingFocus || '').trim().toLowerCase();
  const visualMood = String(analysis?.visualMood || '').trim().toLowerCase();

  const baseByPreset = {
    smooth: { intensity: 40, cameraMotion: 'push-in', highlightStyle: 'glow', textStyle: 'minimal' },
    bold: { intensity: 72, cameraMotion: 'drift-right', highlightStyle: 'sweep', textStyle: 'hero' },
    premium: { intensity: 54, cameraMotion: 'push-in', highlightStyle: 'sweep', textStyle: 'cinematic' },
  };
  const base = baseByPreset[presetSuggestion] || baseByPreset.smooth;

  let intensity = base.intensity;
  if (cameraAngle.includes('macro') || cameraAngle.includes('close')) {
    intensity -= 8;
  } else if (cameraAngle.includes('wide') || cameraAngle.includes('dynamic')) {
    intensity += 6;
  }
  if (visualMood.includes('calm') || visualMood.includes('soft')) {
    intensity -= 6;
  } else if (visualMood.includes('energetic') || visualMood.includes('bold')) {
    intensity += 8;
  }
  intensity = clampNumber(intensity, 22, 86, base.intensity);

  const highlightStyle =
    lightingFocus.includes('cinematic') || lightingFocus.includes('studio')
      ? 'sweep'
      : base.highlightStyle;

  const timing = {
    introFrames: presetSuggestion === 'bold' ? 36 : 44,
    textDelayFrames: presetSuggestion === 'bold' ? 42 : presetSuggestion === 'premium' ? 56 : 50,
    ctaDelayFrames: presetSuggestion === 'bold' ? 122 : presetSuggestion === 'premium' ? 140 : 134,
  };

  const productName = sanitizeText(analysis?.productName, 80);
  const mainIngredient = sanitizeText(analysis?.mainIngredient, 80);
  const backgroundStyle = sanitizeText(analysis?.backgroundStyle, 100);
  const visualMoodLabel = sanitizeText(analysis?.visualMood, 80);

  const headlineSuggestion = isGenericProductName(productName)
    ? ''
    : productName;

  const themeHintsSuggestion = sanitizeText(
    [visualMoodLabel, backgroundStyle, mainIngredient]
      .filter(Boolean)
      .slice(0, 2)
      .join(' • '),
    100
  );

  return {
    presetSuggestion,
    cameraMotion: base.cameraMotion,
    motionIntensity: intensity,
    highlightStyle,
    textStyle: base.textStyle,
    timing,
    headlineSuggestion,
    themeHintsSuggestion,
  };
};

module.exports = {
  buildMotionPlanFromGeminiAnalysis,
};
