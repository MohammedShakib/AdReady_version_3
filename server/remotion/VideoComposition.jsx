import React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const PRESET_CONFIG = Object.freeze({
  smooth: {
    scaleFrom: 1.0,
    scaleTo: 1.08,
    panX: 16,
    panY: -10,
    accentOpacity: 0.25,
    introFrames: 44,
    textDelay: 50,
    ctaDelay: 136,
  },
  bold: {
    scaleFrom: 1.03,
    scaleTo: 1.16,
    panX: 30,
    panY: -18,
    accentOpacity: 0.4,
    introFrames: 36,
    textDelay: 42,
    ctaDelay: 124,
  },
  premium: {
    scaleFrom: 1.0,
    scaleTo: 1.1,
    panX: 20,
    panY: -14,
    accentOpacity: 0.3,
    introFrames: 46,
    textDelay: 58,
    ctaDelay: 142,
  },
});

const VALID_CTA_VALUES = new Set([
  'Shop Now',
  'Buy Now',
  'Learn More',
  'Get Offer',
  'Order Today',
]);

const styles = {
  brandLine: {
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontWeight: 700,
    letterSpacing: '0.14em',
    fontSize: 24,
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.94)',
    textShadow: '0 8px 25px rgba(0,0,0,0.35)',
  },
  headline: {
    marginTop: 14,
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontWeight: 800,
    fontSize: 58,
    lineHeight: 1.05,
    color: 'rgba(255,255,255,0.98)',
    textShadow: '0 10px 28px rgba(0,0,0,0.42)',
    maxWidth: 760,
  },
  cta: {
    marginTop: 24,
    alignSelf: 'flex-start',
    borderRadius: 999,
    padding: '16px 28px',
    fontFamily: 'Arial, Helvetica, sans-serif',
    fontWeight: 700,
    fontSize: 28,
    color: '#061229',
    background: 'rgba(255,255,255,0.92)',
    border: '2px solid rgba(255,255,255,0.95)',
    boxShadow: '0 16px 36px rgba(0,0,0,0.25)',
  },
};

const clamp = (value, min, max, fallback) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
};

const resolveMotionPlan = (plan = {}) => {
  const cameraMotion = String(plan?.cameraMotion || '').trim().toLowerCase();
  const highlightStyle = String(plan?.highlightStyle || '').trim().toLowerCase();
  const textStyle = String(plan?.textStyle || '').trim().toLowerCase();
  const intensityPct = clamp(plan?.motionIntensity, 18, 92, 45);
  const intensity = intensityPct / 100;

  return {
    cameraMotion: cameraMotion || 'push-in',
    highlightStyle: highlightStyle || 'glow',
    textStyle: textStyle || 'minimal',
    intensity,
    introFrames: clamp(plan?.timing?.introFrames, 26, 70, null),
    textDelayFrames: clamp(plan?.timing?.textDelayFrames, 20, 120, null),
    ctaDelayFrames: clamp(plan?.timing?.ctaDelayFrames, 80, 170, null),
  };
};

export const ProductAdVideo = ({
  imageUrl = '',
  preset = 'smooth',
  brandText = '',
  ctaText = '',
  headline = '',
  themeHints = '',
  motionPlan = null,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const config = PRESET_CONFIG[preset] || PRESET_CONFIG.smooth;
  const resolvedPlan = resolveMotionPlan(motionPlan || {});
  const hasBrandText = Boolean(String(brandText || '').trim());
  const hasHeadline = Boolean(String(headline || '').trim());
  const normalizedCta = String(ctaText || '').trim();
  const hasCta = VALID_CTA_VALUES.has(normalizedCta);

  const textScaleByStyle = resolvedPlan.textStyle === 'hero'
    ? 1.08
    : resolvedPlan.textStyle === 'cinematic'
      ? 1.02
      : 1.0;

  const introFrames = resolvedPlan.introFrames || config.introFrames;
  const textDelay = resolvedPlan.textDelayFrames || config.textDelay;
  const ctaDelay = resolvedPlan.ctaDelayFrames || config.ctaDelay;

  const panMultiplier = 0.74 + (resolvedPlan.intensity * 0.68);
  const scaleFrom = config.scaleFrom + (resolvedPlan.intensity * 0.03);
  const scaleTo = config.scaleTo + (resolvedPlan.intensity * 0.08);
  const basePanX = config.panX * panMultiplier;
  const basePanY = config.panY * panMultiplier;

  let endPanX = basePanX;
  let endPanY = basePanY;
  if (resolvedPlan.cameraMotion === 'drift-right') {
    endPanX = Math.abs(basePanX) + 16;
    endPanY = basePanY * 0.62;
  } else if (resolvedPlan.cameraMotion === 'drift-left') {
    endPanX = -Math.abs(basePanX) - 10;
    endPanY = basePanY * 0.7;
  } else if (resolvedPlan.cameraMotion === 'push-out') {
    endPanX = basePanX * 0.52;
    endPanY = basePanY * 0.4;
  }

  const breathingScale = interpolate(
    Math.sin((frame / fps) * Math.PI * 1.2),
    [-1, 1],
    [0.994, 1.008],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const imageScale = interpolate(frame, [0, durationInFrames], [scaleFrom, scaleTo], {
    extrapolateRight: 'clamp',
  }) * breathingScale;
  const imageTranslateX = interpolate(frame, [0, durationInFrames], [0, endPanX], {
    extrapolateRight: 'clamp',
  });
  const imageTranslateY = interpolate(frame, [0, durationInFrames], [0, endPanY], {
    extrapolateRight: 'clamp',
  });

  const introOpacity = interpolate(frame, [0, introFrames], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const textOpacity = interpolate(
    frame,
    [textDelay, textDelay + Math.round(fps * 0.55)],
    [0, 1],
    { extrapolateRight: 'clamp' }
  );
  const ctaOpacity = interpolate(frame, [ctaDelay, ctaDelay + Math.round(fps * 0.46)], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const ctaLift = spring({
    frame: Math.max(0, frame - ctaDelay),
    fps,
    config: { damping: 14, stiffness: 110 },
  });

  const lightSweepProgress = interpolate(frame, [Math.round(fps * 1.4), Math.round(fps * 4.7)], [-70, 120], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const glowPulse = interpolate(
    Math.sin((frame / fps) * Math.PI * 1.35),
    [-1, 1],
    [0.2, 0.72],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  const accentOpacity = clamp(
    config.accentOpacity + resolvedPlan.intensity * 0.22,
    0.16,
    0.6,
    config.accentOpacity
  );

  return (
    <AbsoluteFill style={{ backgroundColor: '#05060a' }}>
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <Img
          src={imageUrl}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `translate(${imageTranslateX}px, ${imageTranslateY}px) scale(${imageScale})`,
            opacity: introOpacity,
          }}
        />
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background:
            'linear-gradient(0deg, rgba(2,6,23,0.82) 0%, rgba(2,6,23,0.55) 33%, rgba(2,6,23,0.18) 68%, rgba(2,6,23,0.05) 100%)',
        }}
      />

      <AbsoluteFill
        style={{
          justifyContent: 'space-between',
          padding: '64px 72px',
        }}
      >
        <div />
        <div style={{ opacity: textOpacity, transform: `scale(${textScaleByStyle})`, transformOrigin: 'left bottom' }}>
          {hasBrandText && <div style={styles.brandLine}>{brandText}</div>}
          {hasHeadline && <div style={styles.headline}>{headline}</div>}
          {!hasHeadline && String(themeHints || '').trim() && (
            <div style={styles.headline}>{String(themeHints || '').trim()}</div>
          )}
          {hasCta && (
            <div
              style={{
                ...styles.cta,
                opacity: ctaOpacity,
                transform: `translateY(${(1 - ctaLift) * 24}px)`,
              }}
            >
              {normalizedCta}
            </div>
          )}
        </div>
      </AbsoluteFill>

      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 18% 10%, rgba(255,255,255,${accentOpacity}) 0%, rgba(255,255,255,0) 36%)`,
          mixBlendMode: 'screen',
        }}
      />

      {resolvedPlan.highlightStyle === 'sweep' && (
        <AbsoluteFill
          style={{
            pointerEvents: 'none',
            background: `linear-gradient(108deg, rgba(255,255,255,0) 35%, rgba(255,255,255,0.24) 52%, rgba(255,255,255,0) 68%)`,
            transform: `translateX(${lightSweepProgress}%)`,
            mixBlendMode: 'screen',
            opacity: 0.66,
          }}
        />
      )}

      {resolvedPlan.highlightStyle === 'glow' && (
        <AbsoluteFill
          style={{
            pointerEvents: 'none',
            background: `radial-gradient(circle at 74% 24%, rgba(255,255,255,${glowPulse * 0.23}) 0%, rgba(255,255,255,0) 42%)`,
            mixBlendMode: 'screen',
          }}
        />
      )}
    </AbsoluteFill>
  );
};
