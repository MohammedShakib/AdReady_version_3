const ALLOWED_CTA_VALUES = ['Shop Now', 'Buy Now', 'Learn More', 'Get Offer', 'Order Today'];
const ALLOWED_ASPECT_RATIOS = ['1:1', '9:16', '4:5', '16:9'];
const ALLOWED_LIGHTING_FOCUS = ['softbox', 'cinematic', 'studio', 'natural'];

const normalizeMainPromptFields = (input = {}) => {
  const productName = String(input.productName || '').trim();
  const mainIngredient = String(input.mainIngredient || '').trim();
  const visualMood = String(input.visualMood || '').trim();
  const dynamicElements = String(input.dynamicElements || '').trim();
  const colorPalette = String(input.colorPalette || '').trim();
  const backgroundStyle = String(input.backgroundStyle || '').trim();
  const brandName = String(input.brandName || '').trim();
  const rawCtaText = String(input.ctaText || '').trim();
  const rawAspectRatio = String(input.aspectRatio || '').trim();
  const rawLightingFocus = String(input.lightingFocus || '').trim().toLowerCase();
  const extraNotes = String(input.extraNotes || '').trim();
  const addQualityTags = input.addQualityTags !== false;
  const hasLogoImage = Boolean(input.hasLogoImage);

  return {
    productName,
    mainIngredient,
    visualMood,
    dynamicElements,
    colorPalette,
    backgroundStyle,
    brandName,
    ctaText: ALLOWED_CTA_VALUES.includes(rawCtaText) ? rawCtaText : '',
    aspectRatio: ALLOWED_ASPECT_RATIOS.includes(rawAspectRatio) ? rawAspectRatio : '1:1',
    lightingFocus: ALLOWED_LIGHTING_FOCUS.includes(rawLightingFocus) ? rawLightingFocus : 'softbox',
    extraNotes,
    addQualityTags,
    hasLogoImage,
  };
};

const buildMainPrompt = (input = {}) => {
  const fields = normalizeMainPromptFields(input);
  const product = fields.productName || 'the product';
  const background = fields.backgroundStyle || 'a clean, premium backdrop';
  const palette = fields.colorPalette || 'complementary';
  const ingredients = fields.mainIngredient || 'signature ingredients';
  const dynamics = fields.dynamicElements || 'subtle motion elements';
  const mood = fields.visualMood || 'premium, cinematic';
  const brand = fields.brandName;
  const cta = fields.ctaText;

  const base = `Create a premium product-ad image with ${product} as the unmistakable hero subject. ` +
    `Place the product in the center with realistic contact shadow, natural reflections, and clean edges. ` +
    `Product dominance rule: keep the product around 45-55% of frame height and make it the strongest focal point. ` +
    `The background features ${background} with a ${palette} color scheme, but keep the background secondary to the product. ` +
    `Use ${dynamics} and ${ingredients} as controlled supporting accents only; avoid clutter, overlap on the label, or a second product. ` +
    `The lighting should be ${mood}.`;

  let branding = '';
  if (fields.hasLogoImage) {
    const ctaLine = cta ? ` Add a "${cta}" button at the bottom.` : '';
    branding =
      `${ctaLine} Keep one corner visually quiet with uninterrupted natural background for a later transparent logo overlay; ` +
      'do not add any logos, brand text, white boxes, solid patches, panels, cards, badges, or placeholder shapes there.';
  } else if (brand || cta) {
    branding =
      ` Add a ${brand ? `brand name "${brand}"` : 'brand logo'} ` +
      `${brand ? 'logo' : ''} at the corner` +
      `${cta ? ` and a "${cta}" button at the bottom.` : '.'}`;
  }

  const framing = ` Lighting focus: ${fields.lightingFocus}. Aspect ratio: ${fields.aspectRatio}.`;
  const quality = fields.addQualityTags
    ? ' High resolution, 8k, photorealistic commercial product photography, crisp focus.'
    : '';
  const extra = fields.extraNotes ? ` Notes: ${fields.extraNotes}.` : '';

  return `${base}${branding}${framing}${quality}${extra}`.replace(/\s+/g, ' ').trim();
};

module.exports = {
  ALLOWED_CTA_VALUES,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_LIGHTING_FOCUS,
  normalizeMainPromptFields,
  buildMainPrompt,
};
