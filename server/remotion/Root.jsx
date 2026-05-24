import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { ProductAdVideo } from './VideoComposition';

const fps = 30;
const durationInFrames = 180;
const width = 1080;
const height = 1080;

const RemotionRoot = () => (
  <Composition
    id="AdReadyProductVideo"
    component={ProductAdVideo}
    durationInFrames={durationInFrames}
    fps={fps}
    width={width}
    height={height}
    defaultProps={{
      imageUrl: '',
      preset: 'smooth',
      brandText: '',
      ctaText: '',
      headline: '',
      themeHints: '',
    }}
  />
);

registerRoot(RemotionRoot);
