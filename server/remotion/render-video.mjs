import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readStdin = async () => {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
};

const ensureParentDirectory = (filePath) => {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });
};

const commonBrowserPaths = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser-stable',
  '/snap/bin/chromium',
];

const commonBrowserNames = [
  'chromium-browser',
  'chromium',
  'google-chrome',
  'google-chrome-stable',
  'chromium-browser-stable',
  'chrome',
];

const resolveExecutableFromPath = (candidate) => {
  const trimmed = String(candidate || '').trim();
  if (!trimmed) {
    return '';
  }
  if (path.isAbsolute(trimmed)) {
    return fs.existsSync(trimmed) ? trimmed : '';
  }
  const whichResult = spawnSync('which', [trimmed], { encoding: 'utf8' });
  if (whichResult.status === 0) {
    const resolved = String(whichResult.stdout || '').trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  }
  return '';
};

const findAvailableBrowserExecutable = () => {
  const envCandidate = String(
    process.env.REMOTION_BROWSER_EXECUTABLE ||
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    ''
  ).trim();
  if (envCandidate) {
    const resolvedEnvExecutable = resolveExecutableFromPath(envCandidate);
    if (resolvedEnvExecutable) {
      return resolvedEnvExecutable;
    }
  }

  for (const browserPath of commonBrowserPaths) {
    if (fs.existsSync(browserPath)) {
      return browserPath;
    }
  }

  for (const browserName of commonBrowserNames) {
    const resolvedByWhich = resolveExecutableFromPath(browserName);
    if (resolvedByWhich) {
      return resolvedByWhich;
    }
  }

  return null;
};

const buildRenderVariants = () => {
  const preferredChromeMode = String(process.env.REMOTION_CHROME_MODE || '').trim().toLowerCase();
  const supportedModes = ['chrome-for-testing', 'headless-shell'];
  const orderedModes = preferredChromeMode && supportedModes.includes(preferredChromeMode)
    ? [preferredChromeMode, ...supportedModes.filter((mode) => mode !== preferredChromeMode)]
    : ['chrome-for-testing', 'headless-shell'];

  const browserExecutable = findAvailableBrowserExecutable();
  const variants = [];
  for (const mode of orderedModes) {
    variants.push({
      chromeMode: mode,
      browserExecutable,
      chromiumOptions: {
        headless: true,
        enableMultiProcessOnLinux: false,
      },
    });
    variants.push({
      chromeMode: mode,
      browserExecutable,
      chromiumOptions: {
        headless: true,
      },
    });
  }

  return variants;
};

const renderWithVariant = async ({ bundledLocation, outputPath, inputProps, variant }) => {
  const commonBrowserOptions = {
    chromeMode: variant.chromeMode,
    browserExecutable: variant.browserExecutable || undefined,
    chromiumOptions: variant.chromiumOptions || {},
    logLevel: process.env.REMOTION_RENDER_LOG_LEVEL || 'info',
  };

  const composition = await selectComposition({
    serveUrl: bundledLocation,
    id: 'AdReadyProductVideo',
    inputProps,
    ...commonBrowserOptions,
  });

  await renderMedia({
    serveUrl: bundledLocation,
    composition,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
    crf: 20,
    pixelFormat: 'yuv420p',
    overwrite: true,
    ...commonBrowserOptions,
  });

  return composition;
};

const run = async () => {
  const rawInput = await readStdin();
  const payload = JSON.parse(rawInput || '{}');
  const outputPath = path.resolve(String(payload?.outputPath || ''));
  const inputProps = payload?.inputProps && typeof payload.inputProps === 'object'
    ? payload.inputProps
    : {};

  if (!outputPath) {
    throw new Error('Missing outputPath');
  }
  ensureParentDirectory(outputPath);

  const entryPoint = path.resolve(__dirname, 'Root.jsx');
  const bundledLocation = await bundle({
    entryPoint,
    onProgress: () => undefined,
  });
  const variants = buildRenderVariants();
  let finalComposition = null;
  let lastError = null;

  for (const variant of variants) {
    try {
      finalComposition = await renderWithVariant({
        bundledLocation,
        outputPath,
        inputProps,
        variant,
      });
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!finalComposition) {
    const detectedBrowserExecutable = findAvailableBrowserExecutable();
    const browserHint = detectedBrowserExecutable ||
      String(process.env.REMOTION_BROWSER_EXECUTABLE || '').trim() ||
      '(auto-download)';
    const isMissingSharedLibError =
      /error while loading shared libraries|libnss3\.so|libatk-1\.0\.so|libx11\.so/i.test(
        String(lastError?.message || '')
      );
    const sharedLibHint = isMissingSharedLibError
      ? 'Linux shared libraries are missing for bundled Chrome (for example libnss3). Install system Chromium and set REMOTION_BROWSER_EXECUTABLE.'
      : 'Set REMOTION_BROWSER_EXECUTABLE to a valid Chromium/Chrome executable path.';
    throw new Error(
      `Video render failed after trying browser launch fallbacks. ` +
      `Hint: ${sharedLibHint} ` +
      `Current browser candidate: ${browserHint}. ` +
      `Last error: ${lastError?.message || 'Unknown error'}`
    );
  }

  const durationSec = Number(finalComposition.durationInFrames / finalComposition.fps).toFixed(2);
  process.stdout.write(JSON.stringify({
    ok: true,
    outputPath,
    durationSec: Number(durationSec),
  }));
};

run().catch((error) => {
  process.stderr.write(String(error?.stack || error?.message || error));
  process.exit(1);
});
