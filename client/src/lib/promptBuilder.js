export const ALLOWED_CTA_VALUES = ['Shop Now', 'Buy Now', 'Learn More', 'Get Offer', 'Order Today'];
export const ALLOWED_ASPECT_RATIOS = ['1:1', '9:16', '4:5', '16:9'];
export const ALLOWED_LIGHTING_FOCUS = ['softbox', 'cinematic', 'studio', 'natural'];

export const normalizeMainPromptFields = (input = {}) => {
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

export const buildMainPrompt = (input = {}) => {
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

export const buildReferenceAwarePrompt = (input = {}) => {
  const fields = normalizeMainPromptFields(input);
  const product = fields.productName || 'the product';
  const ingredients = fields.mainIngredient || '';
  const mood = fields.visualMood || '';
  const palette = fields.colorPalette || '';
  const background = fields.backgroundStyle || '';
  const dynamics = fields.dynamicElements || '';
  const brand = fields.brandName;
  const cta = fields.ctaText;

  const sceneLock =
    `Use the reference image as the base composition. Keep the same scene type, camera angle, layout, props, perspective, and overall environment. ` +
    `Replace only the original hero product with ${product}. Preserve the reference background structure instead of inventing a new concept.`;

  const productRules =
    `Match the new product naturally to the reference scene with realistic scale, contact shadows, reflections, highlights, and placement. ` +
    `Keep the product dominant (roughly 40-52% of frame height unless the original slot is smaller), with readable label and sharp edges. ` +
    `Do not let props, splashes, or floating ingredients hide the product or make it feel tiny/pasted.`;

  const optionalStyle = [
    ingredients ? `Use ${ingredients} only if they fit the reference scene naturally.` : '',
    dynamics ? `Add ${dynamics} only as subtle supporting detail; keep quantity low and do not let them change the original scene layout.` : '',
    mood ? `Keep the overall mood ${mood}.` : '',
    palette ? `Maintain a ${palette} color feeling where it supports the reference scene.` : '',
    background ? `If minor cleanup is needed, steer the environment toward ${background} without changing the core composition.` : '',
  ].filter(Boolean).join(' ');

  let branding = '';
  if (fields.hasLogoImage) {
    const ctaLine = cta ? ` Add a "${cta}" button at the bottom only if it fits the original layout.` : '';
    branding =
      `${ctaLine} Keep one corner visually quiet with uninterrupted natural background for a later transparent logo overlay; ` +
      'do not add logos, brand text, white boxes, solid patches, panels, cards, badges, or placeholder shapes into that area.';
  } else if (brand || cta) {
    branding =
      `${brand ? ` Add brand text "${brand}" only if it can be placed without disturbing the reference composition.` : ''}` +
      `${cta ? ` Add a "${cta}" button only if it can sit naturally in the layout.` : ''}`;
  }

  const framing = ` Lighting focus: ${fields.lightingFocus}. Aspect ratio: ${fields.aspectRatio}.`;
  const quality = fields.addQualityTags
    ? ' High realism, premium advertising finish, cohesive compositing, strong product readability, crisp focus.'
    : '';
  const extra = fields.extraNotes
    ? ` Extra direction: ${fields.extraNotes}.`
    : '';

  return `${sceneLock} ${productRules} ${optionalStyle}${branding}${framing}${quality}${extra}`
    .replace(/\s+/g, ' ')
    .trim();
};
