import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PromptInput from '../components/PromptInput';
import ImageUpload from '../components/ImageUpload';
import BgRemoverModal from '../components/BgRemoverModal';
import SettingsModal from '../components/SettingsModal';
import { apiUrl, getApiBaseUrl } from '../lib/api';
import { resolveAutoPresetFromMeta } from '../video/autoSelectPreset';
import {
  MANUAL_VIDEO_PRESET_VALUES,
  VIDEO_PRESET_MODES,
  VIDEO_PRESET_OPTIONS,
} from '../video/presets';
import '../App.css';

const VIDEO_POLL_INTERVAL_MS = 2000;
const VIDEO_POLL_MAX_ATTEMPTS = 90;
const PRODUCT_VIDEO_CARD_KEY = 'product-upload';
const REFERENCE_PIPELINE_LABEL = 'Reference-img-pipeline-1';

function Dashboard() {
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState(localStorage.getItem('username') || 'User');
  const [currentRole, setCurrentRole] = useState(localStorage.getItem('userRole') || 'member');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedResults, setGeneratedResults] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [errorMessage, setErrorMessage] = useState('');
  const [productImage, setProductImage] = useState('');
  const [referenceImage, setReferenceImage] = useState('');
  const [captionType, setCaptionType] = useState('caption');
  const [usedReferenceImage, setUsedReferenceImage] = useState(false);
  const [lastPrompt, setLastPrompt] = useState('');
  const [editInstruction, setEditInstruction] = useState('');
  const [referenceMode, setReferenceMode] = useState('none');
  const [isFillingAI, setIsFillingAI] = useState(false);
  const [fillError, setFillError] = useState('');
  const [fillValues, setFillValues] = useState(null);
  const [fillAnalysisMeta, setFillAnalysisMeta] = useState(null);
  const [strictReferenceLock, setStrictReferenceLock] = useState(false);
  const [isReferenceTestOpen, setIsReferenceTestOpen] = useState(false);
  const [referenceTestLoadingProvider, setReferenceTestLoadingProvider] = useState('');
  const [referenceRecreateProvider, setReferenceRecreateProvider] = useState('');
  const [referenceAddProductProvider, setReferenceAddProductProvider] = useState('');
  const [referenceTestError, setReferenceTestError] = useState('');
  const [referenceTestResults, setReferenceTestResults] = useState({});
  const [isReferenceTest2Open, setIsReferenceTest2Open] = useState(false);
  const [referenceTest2LoadingProvider, setReferenceTest2LoadingProvider] = useState('');
  const [referenceRecreate2Provider, setReferenceRecreate2Provider] = useState('');
  const [referenceAddProduct2Provider, setReferenceAddProduct2Provider] = useState('');
  const [referenceAutoFlow2Provider, setReferenceAutoFlow2Provider] = useState('');
  const [referenceTest2Error, setReferenceTest2Error] = useState('');
  const [referenceTest2Results, setReferenceTest2Results] = useState({});
  const [referencePipelineStatus, setReferencePipelineStatus] = useState({
    title: REFERENCE_PIPELINE_LABEL,
    step: 'idle',
    message: 'Ready. Click Generate Design to run the pipeline.',
  });
  const [isBgRemoverOpen, setIsBgRemoverOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [videoPresetMode, setVideoPresetMode] = useState(VIDEO_PRESET_MODES.AUTO);
  const [isVideoModalOpen, setIsVideoModalOpen] = useState(false);
  const [videoModalSource, setVideoModalSource] = useState(null);
  const [videoByCardKey, setVideoByCardKey] = useState({});
  const [isSubmittingVideoRender, setIsSubmittingVideoRender] = useState(false);
  const videoPollTimeoutsRef = useRef(new Set());
  const isMountedRef = useRef(true);
  const billingConfirmationAttemptedRef = useRef(false);
  const userInitial = currentUser.charAt(0).toUpperCase();
  const fillQualityScore = Number(fillAnalysisMeta?.qualityScore);
  const hasFillQualityScore = Number.isFinite(fillQualityScore);
  const fillFailureReasons = Array.isArray(fillAnalysisMeta?.failureReasons)
    ? fillAnalysisMeta.failureReasons
      .map((reason) => String(reason || '').trim())
      .filter(Boolean)
    : [];
  const fillGatePassed = fillAnalysisMeta?.gatePassed !== false;
  const apiBaseUrl = getApiBaseUrl();

  const toAbsoluteVideoUrl = useCallback((url) => {
    const normalized = String(url || '').trim();
    if (!normalized) {
      return '';
    }
    if (/^(https?:)?\/\//i.test(normalized) || normalized.startsWith('data:') || normalized.startsWith('blob:')) {
      return normalized;
    }
    return apiBaseUrl ? `${apiBaseUrl}${normalized.startsWith('/') ? normalized : `/${normalized}`}` : normalized;
  }, [apiBaseUrl]);

  const getResultCardKey = useCallback((index, result) => {
    const normalizedUrl = String(result?.imageUrl || '').trim();
    return `${index}:${normalizedUrl}`;
  }, []);

  useEffect(() => {
    if (billingConfirmationAttemptedRef.current) {
      return;
    }

    const authToken = localStorage.getItem('authToken');
    const hash = window.location.hash || '';
    const queryStart = hash.indexOf('?');
    if (!authToken || queryStart === -1) {
      return;
    }

    const routeHash = hash.slice(0, queryStart) || '#/dashboard';
    const params = new URLSearchParams(hash.slice(queryStart + 1));
    const billingStatus = String(params.get('billing') || '').toLowerCase();
    const sessionId = String(params.get('session_id') || '').trim();

    const clearBillingQuery = () => {
      const baseUrl = window.location.href.split('#')[0];
      window.history.replaceState(null, '', `${baseUrl}${routeHash}`);
    };

    if (billingStatus !== 'success' || !sessionId) {
      if (billingStatus) {
        clearBillingQuery();
      }
      return;
    }

    billingConfirmationAttemptedRef.current = true;

    const confirmBillingSession = async () => {
      try {
        const response = await fetch(apiUrl('/api/billing/confirm-session'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({ sessionId }),
        });

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error || payload?.details || 'Could not confirm billing session');
        }

        const upgradedUser = payload?.user;
        if (upgradedUser?.username) {
          localStorage.setItem('username', upgradedUser.username);
          setCurrentUser(upgradedUser.username);
        }
        if (upgradedUser?.role) {
          localStorage.setItem('userRole', upgradedUser.role);
          setCurrentRole(upgradedUser.role);
        }
        if (typeof upgradedUser?.isSuperAdmin === 'boolean') {
          localStorage.setItem('isSuperAdmin', upgradedUser.isSuperAdmin ? 'true' : 'false');
          if (upgradedUser.isSuperAdmin) {
            navigate('/admin', { replace: true });
            return;
          }
        }
      } catch (error) {
        console.error('Billing confirmation failed:', error?.message || error);
      } finally {
        clearBillingQuery();
      }
    };

    confirmBillingSession();
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      videoPollTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      videoPollTimeoutsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const nextKeys = new Set(generatedResults.map((result, index) => getResultCardKey(index, result)));
    setVideoByCardKey((prev) => {
      const filteredEntries = Object.entries(prev).filter(([cardKey]) => nextKeys.has(cardKey));
      if (filteredEntries.length === Object.keys(prev).length) {
        return prev;
      }
      return Object.fromEntries(filteredEntries);
    });
  }, [generatedResults, getResultCardKey]);

  const openImageInNewTab = useCallback((imageUrl) => {
    const normalizedUrl = String(imageUrl || '').trim();
    if (!normalizedUrl) {
      return;
    }

    const dataImageMatch = normalizedUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
    if (dataImageMatch) {
      try {
        const mimeType = String(dataImageMatch[1] || 'image/png').trim() || 'image/png';
        const base64 = String(dataImageMatch[2] || '').replace(/\s+/g, '');
        const binary = window.atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        const openedWindow = window.open(blobUrl, '_blank', 'noopener,noreferrer');
        if (!openedWindow) {
          const tempLink = document.createElement('a');
          tempLink.href = blobUrl;
          tempLink.target = '_blank';
          tempLink.rel = 'noopener noreferrer';
          document.body.appendChild(tempLink);
          tempLink.click();
          tempLink.remove();
        }
        window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return;
      } catch (error) {
        console.error('Failed to open data image in new tab:', error?.message || error);
      }
    }

    window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
  }, []);

  const handleSignOut = useCallback(() => {
    localStorage.removeItem('authToken');
    localStorage.removeItem('username');
    localStorage.removeItem('userId');
    localStorage.removeItem('userRole');
    localStorage.removeItem('isSuperAdmin');
    navigate('/login', { replace: true });
  }, [navigate]);

  const handleGenerate = useCallback(async (input) => {
    const promptText = typeof input === 'string' ? input : input?.prompt;
    const logoImage = typeof input === 'string' ? undefined : input?.logoImage;
    const trimmedPrompt = String(promptText || '').trim();
    if (!trimmedPrompt || isGenerating) {
      return;
    }
    if (!productImage) {
      setErrorMessage('Product image is required');
      return;
    }

    setIsGenerating(true);
    setErrorMessage('');
    if (referenceImage) {
      setReferencePipelineStatus({
        title: REFERENCE_PIPELINE_LABEL,
        step: 'queued',
        message: 'Queued. Starting reference image pipeline...',
      });
    }

    try {
      const authToken = localStorage.getItem('authToken');
      const parseServerError = async (response, fallbackMessage) => {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        return (
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `${fallbackMessage} (HTTP ${response.status})`
        );
      };
      const generateOnce = async (generationVariant = '', trackProgress = false) => {
        if (referenceImage) {
          const normalizedVariant = generationVariant || 'reference_exact';
          if (trackProgress) {
            setReferencePipelineStatus({
              title: REFERENCE_PIPELINE_LABEL,
              step: 'prompt_generated',
              message: 'Step 1/3: Prompt generated from reference scene analysis...',
            });
          }
          const readResponse = await fetch(apiUrl('/api/reference/test-read'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({
              referenceImage,
              provider: 'gemini',
              promptText: trimmedPrompt,
              generationVariant: normalizedVariant,
            }),
          });

          if (!readResponse.ok) {
            throw new Error(await parseServerError(readResponse, 'Reference analysis failed'));
          }

          const readData = await readResponse.json();
          const builtPrompt = String(
            readData?.builtPrompt ||
            readData?.promptBundle?.scenePrompt ||
            readData?.promptBundle?.backgroundPrompt ||
            ''
          ).trim();
          if (!builtPrompt) {
            throw new Error('Reference analysis returned empty built prompt');
          }
          if (trackProgress) {
            setReferencePipelineStatus({
              title: REFERENCE_PIPELINE_LABEL,
              step: 'recreate_scene',
              message: 'Step 2/3: Recreating clean reference scene...',
            });
          }

          const recreateResponse = await fetch(apiUrl('/api/generate'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({
              prompt: builtPrompt,
              referenceImage,
              referenceMode: 'auto',
              generationVariant: normalizedVariant,
              skipCaptionGeneration: true,
            }),
          });

          if (!recreateResponse.ok) {
            throw new Error(await parseServerError(recreateResponse, 'Reference scene recreation failed'));
          }

          const recreateData = await recreateResponse.json();
          const recreatedImageUrl = String(recreateData?.imageUrl || '').trim();
          if (!recreatedImageUrl) {
            throw new Error('Reference scene recreation returned empty image');
          }
          if (trackProgress) {
            setReferencePipelineStatus({
              title: REFERENCE_PIPELINE_LABEL,
              step: 'add_product',
              message: 'Step 3/3: Adding product and running quality checks...',
            });
          }

          const placeResponse = await fetch(apiUrl('/api/reference/place-product'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
            },
            body: JSON.stringify({
              recreatedImage: recreatedImageUrl,
              productImage,
              referenceImage,
              scenePlan: readData?.scenePlan || undefined,
              promptText: builtPrompt,
              requestedAspectRatio: '1:1',
            }),
          });

          if (!placeResponse.ok) {
            throw new Error(await parseServerError(placeResponse, 'Product placement failed'));
          }

          const placeData = await placeResponse.json();
          const finalImageUrl = String(placeData?.imageUrl || '').trim();
          if (!finalImageUrl) {
            throw new Error('Product placement returned empty image');
          }
          if (trackProgress) {
            setReferencePipelineStatus({
              title: REFERENCE_PIPELINE_LABEL,
              step: 'completed',
              message: 'Completed: scene recreated, product placed, QA passed.',
            });
          }

          return {
            caption: '',
            imageUrl: finalImageUrl,
            captionType: 'none',
            usedReferenceImage: true,
            editInstruction: '',
            referenceMode: 'overlay',
            backgroundPrompt: builtPrompt,
            generationVariant: normalizedVariant,
            resultLabel: REFERENCE_PIPELINE_LABEL,
          };
        }

        const response = await fetch(apiUrl('/api/generate'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            prompt: trimmedPrompt,
            productImage: productImage || undefined,
            referenceImage: referenceImage || undefined,
            referenceMode: 'auto',
            strictReferenceLock: Boolean(referenceImage) && strictReferenceLock,
            logoImage: logoImage || undefined,
            generationVariant: generationVariant || undefined,
            skipCaptionGeneration: true,
          }),
        });

        if (!response.ok) {
          const errorPayload = await response.json().catch(() => ({}));
          const serverMessage = errorPayload?.details || errorPayload?.error || 'Request failed';
          throw new Error(serverMessage);
        }

        const data = await response.json();
        return {
          caption: '',
          imageUrl: data?.imageUrl || '',
          captionType: 'none',
          usedReferenceImage: Boolean(data?.usedReferenceImage),
          editInstruction: data?.editInstruction || '',
          referenceMode: data?.referenceMode || 'none',
          backgroundPrompt: data?.backgroundPrompt || '',
          generationVariant: data?.generationVariant || generationVariant || '',
          resultLabel: '',
        };
      };

      const generationTasks = referenceImage
        ? [generateOnce('reference_exact', true), generateOnce('reference_exact_alt', false)]
        : [generateOnce(), generateOnce()];
      const results = await Promise.allSettled(generationTasks);
      const successes = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);

      if (successes.length === 0) {
        const firstError = results.find((result) => result.status === 'rejected');
        throw new Error(firstError?.reason?.message || 'Generation failed');
      }

      const primary = successes[0];

      setGeneratedResults(successes);
      setVideoByCardKey({});
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      setSelectedIndex(0);
      setCaptionType(primary.captionType);
      setUsedReferenceImage(primary.usedReferenceImage);
      setLastPrompt(trimmedPrompt);
      setEditInstruction(primary.editInstruction);
      setReferenceMode(primary.referenceMode);
    } catch (error) {
      const message = error?.message || 'Generation failed';
      setErrorMessage(message);
      if (referenceImage) {
        setReferencePipelineStatus({
          title: REFERENCE_PIPELINE_LABEL,
          step: 'failed',
          message: `Failed: ${message}`,
        });
      }
      console.error('Generate failed:', message);
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, productImage, referenceImage, strictReferenceLock]);

  const handleFillWithAI = useCallback(async () => {
    if (!productImage) {
      setFillError('Product image is required');
      return;
    }

    setIsFillingAI(true);
    setFillError('');
    setFillAnalysisMeta(null);

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/analyze'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          productImage,
          referenceImage: productImage,
          provider: 'gemini',
        }),
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => ({}));
        const serverMessage = errorPayload?.details || errorPayload?.error || 'Analysis failed';
        throw new Error(serverMessage);
      }

      const data = await response.json();
      setFillValues(data);
      setFillAnalysisMeta(data?.analysisMeta && typeof data.analysisMeta === 'object' ? data.analysisMeta : null);
    } catch (error) {
      const message = error?.message || 'Analysis failed';
      setFillError(message);
      setFillAnalysisMeta(null);
    } finally {
      setIsFillingAI(false);
    }
  }, [productImage]);

  const handleSelectResult = useCallback((index, result) => {
    setSelectedIndex(index);
    setEditInstruction(result.editInstruction || '');
    setReferenceMode(result.referenceMode || 'none');
  }, []);

  const buildVideoMeta = useCallback(() => {
    const raw = fillValues && typeof fillValues === 'object' ? fillValues : {};
    return {
      brandName: String(raw?.brandName || '').trim(),
      ctaText: String(raw?.ctaText || '').trim(),
      productName: String(raw?.productName || '').trim(),
      visualMood: String(raw?.visualMood || '').trim(),
      aspectRatio: String(raw?.aspectRatio || '1:1').trim() || '1:1',
      extraNotes: String(raw?.extraNotes || '').trim(),
    };
  }, [fillValues]);

  const openVideoModalForCard = useCallback((index) => {
    if (!generatedResults[index]?.imageUrl) {
      return;
    }
    const result = generatedResults[index];
    setVideoModalSource({
      type: 'generated',
      index,
      imageUrl: result.imageUrl,
      cardKey: getResultCardKey(index, result),
    });
    setVideoPresetMode(VIDEO_PRESET_MODES.AUTO);
    setIsVideoModalOpen(true);
  }, [generatedResults, getResultCardKey]);

  const openVideoModalForProductImage = useCallback(() => {
    const imageUrl = String(productImage || '').trim();
    if (!imageUrl) {
      return;
    }
    setVideoModalSource({
      type: 'product',
      index: null,
      imageUrl,
      cardKey: PRODUCT_VIDEO_CARD_KEY,
    });
    setVideoPresetMode(VIDEO_PRESET_MODES.AUTO);
    setIsVideoModalOpen(true);
  }, [productImage]);

  const closeVideoModal = useCallback(() => {
    if (isSubmittingVideoRender) {
      return;
    }
    setIsVideoModalOpen(false);
    setVideoModalSource(null);
  }, [isSubmittingVideoRender]);

  const updateVideoCardState = useCallback((cardKey, patch) => {
    setVideoByCardKey((prev) => ({
      ...prev,
      [cardKey]: {
        ...(prev[cardKey] || {}),
        ...patch,
      },
    }));
  }, []);

  const pollVideoRenderJob = useCallback(async ({ cardKey, jobId }) => {
    const authToken = localStorage.getItem('authToken');
    for (let attempt = 0; attempt < VIDEO_POLL_MAX_ATTEMPTS; attempt += 1) {
      if (!isMountedRef.current) {
        return;
      }

      const response = await fetch(apiUrl(`/api/video/render/${jobId}`), {
        method: 'GET',
        headers: {
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || payload?.details || `Video status check failed (HTTP ${response.status})`);
      }
      const sharedPatch = {
        analysisMode: String(payload?.analysisMode || '').trim().toLowerCase() || undefined,
        geminiAnalysis: payload?.geminiAnalysis && typeof payload.geminiAnalysis === 'object'
          ? payload.geminiAnalysis
          : null,
        remotionInstruction: payload?.remotionInstruction && typeof payload.remotionInstruction === 'object'
          ? payload.remotionInstruction
          : null,
      };

      const status = String(payload?.status || '').toLowerCase();
      if (status === 'completed') {
        updateVideoCardState(cardKey, {
          status: 'completed',
          videoUrl: toAbsoluteVideoUrl(payload?.videoUrl),
          presetUsed: String(payload?.presetUsed || '').trim().toLowerCase(),
          error: '',
          ...sharedPatch,
        });
        return;
      }
      if (status === 'failed') {
        updateVideoCardState(cardKey, {
          status: 'failed',
          error: payload?.error || 'Video render failed',
          ...sharedPatch,
        });
        return;
      }

      updateVideoCardState(cardKey, { status: status || 'rendering', ...sharedPatch });

      await new Promise((resolve) => {
        const timeoutId = window.setTimeout(() => {
          videoPollTimeoutsRef.current.delete(timeoutId);
          resolve();
        }, VIDEO_POLL_INTERVAL_MS);
        videoPollTimeoutsRef.current.add(timeoutId);
      });
    }

    updateVideoCardState(cardKey, {
      status: 'failed',
      error: 'Video render timed out. Please retry.',
    });
  }, [toAbsoluteVideoUrl, updateVideoCardState]);

  const handleSubmitVideoRender = useCallback(async () => {
    if (!videoModalSource?.imageUrl || !videoModalSource?.cardKey) {
      return;
    }
    const imageUrl = String(videoModalSource.imageUrl || '').trim();
    if (!imageUrl) {
      return;
    }

    const cardKey = String(videoModalSource.cardKey || '').trim();
    const meta = buildVideoMeta();
    const resolvedPresetMode =
      videoPresetMode === VIDEO_PRESET_MODES.AUTO
        ? VIDEO_PRESET_MODES.AUTO
        : MANUAL_VIDEO_PRESET_VALUES.has(videoPresetMode)
          ? videoPresetMode
          : VIDEO_PRESET_MODES.AUTO;

    setIsSubmittingVideoRender(true);
    updateVideoCardState(cardKey, {
      status: 'queued',
      videoUrl: '',
      error: '',
      presetRequested: resolvedPresetMode,
      presetResolvedClient:
        resolvedPresetMode === VIDEO_PRESET_MODES.AUTO
          ? resolveAutoPresetFromMeta(meta)
          : resolvedPresetMode,
    });

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/video/render'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          imageUrl,
          presetMode: resolvedPresetMode,
          meta,
          headline: meta.productName || 'Product Spotlight',
          themeHints: meta.visualMood || '',
        }),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error || payload?.details || `Video render failed (HTTP ${response.status})`);
      }

      const jobId = String(payload?.jobId || '').trim();
      if (!jobId) {
        throw new Error('Invalid render job response');
      }

      updateVideoCardState(cardKey, {
        status: String(payload?.status || 'queued').toLowerCase(),
        jobId,
      });
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      await pollVideoRenderJob({ cardKey, jobId });
    } catch (error) {
      updateVideoCardState(cardKey, {
        status: 'failed',
        error: error?.message || 'Video render failed',
      });
    } finally {
      if (isMountedRef.current) {
        setIsSubmittingVideoRender(false);
      }
    }
  }, [
    videoModalSource,
    buildVideoMeta,
    videoPresetMode,
    updateVideoCardState,
    pollVideoRenderJob,
  ]);

  const handleReferenceReadTest = useCallback(async (provider) => {
    if (!referenceImage || referenceTestLoadingProvider) {
      return;
    }

    setReferenceTestLoadingProvider(provider);
    setReferenceTestError('');

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/reference/test-read'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          referenceImage,
          provider,
          generationVariant: 'reference_exact',
        }),
      });

      if (!response.ok) {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Reference analysis failed (HTTP ${response.status})`;
        throw new Error(serverMessage);
      }

      const data = await response.json();
      const normalizedProvider = String(data?.provider || provider || '').toLowerCase();
      setReferenceTestResults((prev) => ({
        ...prev,
        [normalizedProvider]: {
          scenePlan: data?.scenePlan || null,
          promptBundle: data?.promptBundle || null,
          builtPrompt: String(
            data?.builtPrompt ||
            data?.promptBundle?.scenePrompt ||
            data?.promptBundle?.backgroundPrompt ||
            ''
          ).trim(),
          recreatedImageUrl: '',
          productAddedImageUrl: '',
        },
      }));
    } catch (error) {
      setReferenceTestError(error?.message || 'Reference analysis failed');
    } finally {
      setReferenceTestLoadingProvider('');
    }
  }, [referenceImage, referenceTestLoadingProvider]);

  const handleReferenceRecreate = useCallback(async (provider) => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const providerResult = referenceTestResults?.[normalizedProvider];
    const builtPrompt = String(providerResult?.builtPrompt || '').trim();
    if (
      !referenceImage ||
      !builtPrompt ||
      isGenerating ||
      referenceTestLoadingProvider ||
      referenceRecreateProvider
    ) {
      return;
    }

    setReferenceRecreateProvider(normalizedProvider);
    setReferenceTestError('');
    setErrorMessage('');
    setIsGenerating(true);

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          prompt: builtPrompt,
          referenceImage,
          referenceMode: 'auto',
          generationVariant: 'reference_exact',
          skipCaptionGeneration: true,
        }),
      });

      if (!response.ok) {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Image recreation failed (HTTP ${response.status})`;
        throw new Error(serverMessage);
      }

      const data = await response.json();
      const recreatedResult = {
        caption: '',
        imageUrl: data?.imageUrl || '',
        captionType: 'none',
        usedReferenceImage: Boolean(data?.usedReferenceImage),
        editInstruction: data?.editInstruction || '',
        referenceMode: data?.referenceMode || 'none',
        backgroundPrompt: data?.backgroundPrompt || '',
        generationVariant: data?.generationVariant || 'reference_exact',
      };

      if (!recreatedResult.imageUrl) {
        throw new Error('Image recreation failed: empty image response');
      }

      setReferenceTestResults((prev) => ({
        ...prev,
        [normalizedProvider]: {
          ...(prev?.[normalizedProvider] || {}),
          recreatedImageUrl: recreatedResult.imageUrl,
          productAddedImageUrl: '',
        },
      }));
      setGeneratedResults([recreatedResult]);
      setVideoByCardKey({});
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      setSelectedIndex(0);
      setCaptionType(recreatedResult.captionType);
      setUsedReferenceImage(recreatedResult.usedReferenceImage);
      setLastPrompt(builtPrompt);
      setEditInstruction(recreatedResult.editInstruction);
      setReferenceMode(recreatedResult.referenceMode);
    } catch (error) {
      const message = error?.message || 'Image recreation failed';
      setReferenceTestError(message);
      setErrorMessage(message);
    } finally {
      setReferenceRecreateProvider('');
      setIsGenerating(false);
    }
  }, [
    isGenerating,
    referenceImage,
    referenceRecreateProvider,
    referenceTestLoadingProvider,
    referenceTestResults,
  ]);

  const handleReferenceAddProduct = useCallback(async (provider) => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const providerResult = referenceTestResults?.[normalizedProvider];
    const recreatedImageUrl = String(providerResult?.recreatedImageUrl || '').trim();
    if (
      !recreatedImageUrl ||
      !productImage ||
      !referenceImage ||
      isGenerating ||
      referenceTestLoadingProvider ||
      referenceRecreateProvider ||
      referenceAddProductProvider
    ) {
      return;
    }

    setReferenceAddProductProvider(normalizedProvider);
    setReferenceTestError('');
    setErrorMessage('');
    setIsGenerating(true);

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/reference/place-product'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          recreatedImage: recreatedImageUrl,
          productImage,
          referenceImage,
          scenePlan: providerResult?.scenePlan || undefined,
          promptText: providerResult?.builtPrompt || '',
          requestedAspectRatio: '1:1',
        }),
      });

      if (!response.ok) {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Product placement failed (HTTP ${response.status})`;
        throw new Error(serverMessage);
      }

      const data = await response.json();
      const finalImageUrl = String(data?.imageUrl || '').trim();
      if (!finalImageUrl) {
        throw new Error('Product placement failed: empty image response');
      }

      setReferenceTestResults((prev) => ({
        ...prev,
        [normalizedProvider]: {
          ...(prev?.[normalizedProvider] || {}),
          productAddedImageUrl: finalImageUrl,
        },
      }));

      const placedResult = {
        caption: '',
        imageUrl: finalImageUrl,
        captionType: 'none',
        usedReferenceImage: true,
        editInstruction: '',
        referenceMode: 'overlay',
        backgroundPrompt: providerResult?.builtPrompt || '',
        generationVariant: 'reference_exact',
      };
      setGeneratedResults([placedResult]);
      setVideoByCardKey({});
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      setSelectedIndex(0);
      setCaptionType('none');
      setUsedReferenceImage(true);
      setLastPrompt(String(providerResult?.builtPrompt || '').trim());
      setEditInstruction('');
      setReferenceMode('overlay');
    } catch (error) {
      const message = error?.message || 'Product placement failed';
      setReferenceTestError(message);
      setErrorMessage(message);
    } finally {
      setReferenceAddProductProvider('');
      setIsGenerating(false);
    }
  }, [
    isGenerating,
    productImage,
    referenceAddProductProvider,
    referenceImage,
    referenceRecreateProvider,
    referenceTestLoadingProvider,
    referenceTestResults,
  ]);

  const handleReferenceReadTest2 = useCallback(async (provider) => {
    if (!referenceImage || referenceTest2LoadingProvider) {
      return;
    }

    setReferenceTest2LoadingProvider(provider);
    setReferenceTest2Error('');

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/reference/test-read'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          referenceImage,
          provider,
          generationVariant: 'reference_exact',
        }),
      });

      if (!response.ok) {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Reference analysis failed (HTTP ${response.status})`;
        throw new Error(serverMessage);
      }

      const data = await response.json();
      const normalizedProvider = String(data?.provider || provider || '').toLowerCase();
      setReferenceTest2Results((prev) => ({
        ...prev,
        [normalizedProvider]: {
          scenePlan: data?.scenePlan || null,
          promptBundle: data?.promptBundle || null,
          builtPrompt: String(
            data?.builtPrompt ||
            data?.promptBundle?.scenePrompt ||
            data?.promptBundle?.backgroundPrompt ||
            ''
          ).trim(),
          recreatedImageUrl: '',
          productAddedImageUrl: '',
        },
      }));
    } catch (error) {
      setReferenceTest2Error(error?.message || 'Reference analysis failed');
    } finally {
      setReferenceTest2LoadingProvider('');
    }
  }, [referenceImage, referenceTest2LoadingProvider]);

  const handleReferenceRecreate2 = useCallback(async (provider) => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const providerResult = referenceTest2Results?.[normalizedProvider];
    const builtPrompt = String(providerResult?.builtPrompt || '').trim();
    if (
      !referenceImage ||
      !builtPrompt ||
      isGenerating ||
      referenceTest2LoadingProvider ||
      referenceRecreate2Provider
    ) {
      return;
    }

    setReferenceRecreate2Provider(normalizedProvider);
    setReferenceTest2Error('');
    setErrorMessage('');
    setIsGenerating(true);

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          prompt: builtPrompt,
          referenceImage,
          referenceMode: 'auto',
          generationVariant: 'reference_exact',
          skipCaptionGeneration: true,
        }),
      });

      if (!response.ok) {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Image recreation failed (HTTP ${response.status})`;
        throw new Error(serverMessage);
      }

      const data = await response.json();
      const recreatedResult = {
        caption: '',
        imageUrl: data?.imageUrl || '',
        captionType: 'none',
        usedReferenceImage: Boolean(data?.usedReferenceImage),
        editInstruction: data?.editInstruction || '',
        referenceMode: data?.referenceMode || 'none',
        backgroundPrompt: data?.backgroundPrompt || '',
        generationVariant: data?.generationVariant || 'reference_exact',
      };

      if (!recreatedResult.imageUrl) {
        throw new Error('Image recreation failed: empty image response');
      }

      setReferenceTest2Results((prev) => ({
        ...prev,
        [normalizedProvider]: {
          ...(prev?.[normalizedProvider] || {}),
          recreatedImageUrl: recreatedResult.imageUrl,
          productAddedImageUrl: '',
        },
      }));
      setGeneratedResults([recreatedResult]);
      setVideoByCardKey({});
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      setSelectedIndex(0);
      setCaptionType(recreatedResult.captionType);
      setUsedReferenceImage(recreatedResult.usedReferenceImage);
      setLastPrompt(builtPrompt);
      setEditInstruction(recreatedResult.editInstruction);
      setReferenceMode(recreatedResult.referenceMode);
    } catch (error) {
      const message = error?.message || 'Image recreation failed';
      setReferenceTest2Error(message);
      setErrorMessage(message);
    } finally {
      setReferenceRecreate2Provider('');
      setIsGenerating(false);
    }
  }, [
    isGenerating,
    referenceImage,
    referenceRecreate2Provider,
    referenceTest2LoadingProvider,
    referenceTest2Results,
  ]);

  const handleReferenceAddProduct2 = useCallback(async (provider) => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    const providerResult = referenceTest2Results?.[normalizedProvider];
    const recreatedImageUrl = String(providerResult?.recreatedImageUrl || '').trim();
    if (
      !recreatedImageUrl ||
      !productImage ||
      !referenceImage ||
      isGenerating ||
      referenceTest2LoadingProvider ||
      referenceRecreate2Provider ||
      referenceAddProduct2Provider
    ) {
      return;
    }

    setReferenceAddProduct2Provider(normalizedProvider);
    setReferenceTest2Error('');
    setErrorMessage('');
    setIsGenerating(true);

    try {
      const authToken = localStorage.getItem('authToken');
      const response = await fetch(apiUrl('/api/reference/place-product'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          recreatedImage: recreatedImageUrl,
          productImage,
          referenceImage,
          scenePlan: providerResult?.scenePlan || undefined,
          promptText: providerResult?.builtPrompt || '',
          requestedAspectRatio: '1:1',
        }),
      });

      if (!response.ok) {
        const responseClone = response.clone();
        const errorPayload = await response.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Product placement failed (HTTP ${response.status})`;
        throw new Error(serverMessage);
      }

      const data = await response.json();
      const finalImageUrl = String(data?.imageUrl || '').trim();
      if (!finalImageUrl) {
        throw new Error('Product placement failed: empty image response');
      }

      setReferenceTest2Results((prev) => ({
        ...prev,
        [normalizedProvider]: {
          ...(prev?.[normalizedProvider] || {}),
          productAddedImageUrl: finalImageUrl,
        },
      }));

      const placedResult = {
        caption: '',
        imageUrl: finalImageUrl,
        captionType: 'none',
        usedReferenceImage: true,
        editInstruction: '',
        referenceMode: 'overlay',
        backgroundPrompt: providerResult?.builtPrompt || '',
        generationVariant: 'reference_exact',
      };
      setGeneratedResults([placedResult]);
      setVideoByCardKey({});
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      setSelectedIndex(0);
      setCaptionType('none');
      setUsedReferenceImage(true);
      setLastPrompt(String(providerResult?.builtPrompt || '').trim());
      setEditInstruction('');
      setReferenceMode('overlay');
    } catch (error) {
      const message = error?.message || 'Product placement failed';
      setReferenceTest2Error(message);
      setErrorMessage(message);
    } finally {
      setReferenceAddProduct2Provider('');
      setIsGenerating(false);
    }
  }, [
    isGenerating,
    productImage,
    referenceAddProduct2Provider,
    referenceImage,
    referenceRecreate2Provider,
    referenceTest2LoadingProvider,
    referenceTest2Results,
  ]);

  const handleReferenceAutoFlow2 = useCallback(async (provider) => {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (
      !referenceImage ||
      !productImage ||
      !normalizedProvider ||
      (normalizedProvider !== 'openai' && normalizedProvider !== 'gemini') ||
      isGenerating ||
      referenceTest2LoadingProvider ||
      referenceRecreate2Provider ||
      referenceAddProduct2Provider ||
      referenceAutoFlow2Provider
    ) {
      return;
    }

    setReferenceAutoFlow2Provider(normalizedProvider);
    setReferenceTest2LoadingProvider(normalizedProvider);
    setReferenceRecreate2Provider(normalizedProvider);
    setReferenceAddProduct2Provider(normalizedProvider);
    setReferenceTest2Error('');
    setErrorMessage('');
    setIsGenerating(true);

    try {
      const authToken = localStorage.getItem('authToken');

      const readResponse = await fetch(apiUrl('/api/reference/test-read'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          referenceImage,
          provider: normalizedProvider,
          generationVariant: 'reference_exact',
        }),
      });

      if (!readResponse.ok) {
        const responseClone = readResponse.clone();
        const errorPayload = await readResponse.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Reference analysis failed (HTTP ${readResponse.status})`;
        throw new Error(serverMessage);
      }

      const readData = await readResponse.json();
      const scenePlan = readData?.scenePlan || null;
      const builtPrompt = String(
        readData?.builtPrompt ||
        readData?.promptBundle?.scenePrompt ||
        readData?.promptBundle?.backgroundPrompt ||
        ''
      ).trim();
      if (!builtPrompt) {
        throw new Error('Reference analysis returned empty built prompt');
      }

      setReferenceTest2Results((prev) => ({
        ...prev,
        [normalizedProvider]: {
          scenePlan,
          promptBundle: readData?.promptBundle || null,
          builtPrompt,
          recreatedImageUrl: '',
          productAddedImageUrl: '',
        },
      }));

      const recreateResponse = await fetch(apiUrl('/api/generate'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          prompt: builtPrompt,
          referenceImage,
          referenceMode: 'auto',
          generationVariant: 'reference_exact',
          skipCaptionGeneration: true,
        }),
      });

      if (!recreateResponse.ok) {
        const responseClone = recreateResponse.clone();
        const errorPayload = await recreateResponse.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Image recreation failed (HTTP ${recreateResponse.status})`;
        throw new Error(serverMessage);
      }

      const recreateData = await recreateResponse.json();
      const recreatedImageUrl = String(recreateData?.imageUrl || '').trim();
      if (!recreatedImageUrl) {
        throw new Error('Image recreation failed: empty image response');
      }

      setReferenceTest2Results((prev) => ({
        ...prev,
        [normalizedProvider]: {
          ...(prev?.[normalizedProvider] || {}),
          recreatedImageUrl,
          productAddedImageUrl: '',
        },
      }));

      const placeResponse = await fetch(apiUrl('/api/reference/place-product'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          recreatedImage: recreatedImageUrl,
          productImage,
          referenceImage,
          scenePlan: scenePlan || undefined,
          promptText: builtPrompt,
          requestedAspectRatio: '1:1',
        }),
      });

      if (!placeResponse.ok) {
        const responseClone = placeResponse.clone();
        const errorPayload = await placeResponse.json().catch(() => null);
        const fallbackText = await responseClone.text().catch(() => '');
        const serverMessage =
          errorPayload?.details ||
          errorPayload?.error ||
          fallbackText ||
          `Product placement failed (HTTP ${placeResponse.status})`;
        throw new Error(serverMessage);
      }

      const placeData = await placeResponse.json();
      const finalImageUrl = String(placeData?.imageUrl || '').trim();
      if (!finalImageUrl) {
        throw new Error('Product placement failed: empty image response');
      }

      setReferenceTest2Results((prev) => ({
        ...prev,
        [normalizedProvider]: {
          ...(prev?.[normalizedProvider] || {}),
          productAddedImageUrl: finalImageUrl,
        },
      }));

      const placedResult = {
        caption: '',
        imageUrl: finalImageUrl,
        captionType: 'none',
        usedReferenceImage: true,
        editInstruction: '',
        referenceMode: 'overlay',
        backgroundPrompt: builtPrompt,
        generationVariant: 'reference_exact',
      };
      setGeneratedResults([placedResult]);
      setVideoByCardKey({});
      setIsVideoModalOpen(false);
      setVideoModalSource(null);
      setSelectedIndex(0);
      setCaptionType('none');
      setUsedReferenceImage(true);
      setLastPrompt(builtPrompt);
      setEditInstruction('');
      setReferenceMode('overlay');
    } catch (error) {
      const message = error?.message || 'Automatic reference flow failed';
      setReferenceTest2Error(message);
      setErrorMessage(message);
    } finally {
      setReferenceAutoFlow2Provider('');
      setReferenceTest2LoadingProvider('');
      setReferenceRecreate2Provider('');
      setReferenceAddProduct2Provider('');
      setIsGenerating(false);
    }
  }, [
    isGenerating,
    productImage,
    referenceAddProduct2Provider,
    referenceAutoFlow2Provider,
    referenceImage,
    referenceRecreate2Provider,
    referenceTest2LoadingProvider,
  ]);

  const renderVideoAnalysisDetails = useCallback((videoState) => {
    if (!videoState || (videoState.status !== 'completed' && videoState.status !== 'rendering' && videoState.status !== 'queued')) {
      return null;
    }

    const mode = String(videoState?.analysisMode || '').trim().toLowerCase();
    const gemini = videoState?.geminiAnalysis && typeof videoState.geminiAnalysis === 'object'
      ? videoState.geminiAnalysis
      : null;
    const instruction = videoState?.remotionInstruction && typeof videoState.remotionInstruction === 'object'
      ? videoState.remotionInstruction
      : null;

    const isRendering = videoState.status === 'queued' || videoState.status === 'rendering';
    const isCompleted = videoState.status === 'completed';

    return (
      <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-left">
        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Video Planning</p>
        <p className="mt-1 text-[11px] text-slate-700">
          Analysis mode: <span className="font-semibold">
            {mode === 'gemini' ? 'Gemini' : mode ? 'Basic fallback' : (isRendering ? 'Gemini analysis pending' : 'Not returned')}
          </span>
        </p>
        {!gemini && !instruction && isRendering && (
          <p className="mt-1 text-[11px] text-slate-600">
            Gemini analysis চলছে... complete হলে details show করবে।
          </p>
        )}
        {!gemini && !instruction && isCompleted && (
          <p className="mt-1 text-[11px] text-slate-600">
            Analysis summary পাওয়া যায়নি (সম্ভবত old backend deploy বা Gemini fallback path)।
          </p>
        )}
        {gemini && (
          <div className="mt-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Gemini Analysis</p>
            <p className="mt-1 text-[11px] text-slate-700 leading-relaxed">
              Product: {gemini?.productName || '-'} | Mood: {gemini?.visualMood || '-'} | Lighting: {gemini?.lightingFocus || '-'}
            </p>
            <p className="mt-1 text-[11px] text-slate-600 leading-relaxed">
              Ingredient: {gemini?.mainIngredient || '-'} | Background: {gemini?.backgroundStyle || '-'} | Motion cues: {gemini?.dynamicElements || '-'}
            </p>
          </div>
        )}
        {instruction && (
          <div className="mt-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Remotion Instruction</p>
            <p className="mt-1 text-[11px] text-slate-700 leading-relaxed">
              Preset: {instruction?.presetSuggestion || '-'} | Camera: {instruction?.cameraMotion || '-'} | Intensity: {instruction?.motionIntensity ?? '-'}
            </p>
            <p className="mt-1 text-[11px] text-slate-600 leading-relaxed">
              Highlight: {instruction?.highlightStyle || '-'} | Text style: {instruction?.textStyle || '-'} | Timing: intro {instruction?.timing?.introFrames ?? '-'}f, text {instruction?.timing?.textDelayFrames ?? '-'}f, cta {instruction?.timing?.ctaDelayFrames ?? '-'}f
            </p>
          </div>
        )}
      </div>
    );
  }, []);

  const selectedResult = generatedResults[selectedIndex] || null;
  const selectedCardKey = selectedResult ? getResultCardKey(selectedIndex, selectedResult) : '';
  const selectedVideoState = selectedCardKey ? videoByCardKey[selectedCardKey] || null : null;
  const productVideoState = videoByCardKey[PRODUCT_VIDEO_CARD_KEY] || null;
  const videoModalResult = videoModalSource && videoModalSource.imageUrl
    ? { imageUrl: videoModalSource.imageUrl }
    : null;

  return (
    <>
      <div className="flex h-screen bg-slate-50 overflow-hidden font-sans text-slate-900 selection:bg-indigo-500/30">

      {/* Decorative Background Elements */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-5%] w-[40%] h-[40%] rounded-full bg-indigo-500/5 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-5%] w-[40%] h-[40%] rounded-full bg-sky-500/5 blur-[120px]" />
      </div>

      <aside className="w-[420px] flex-shrink-0 bg-[#f8f9fa] border-r border-slate-200 flex flex-col h-full overflow-hidden relative z-10">
        <div className="p-8 pb-6 bg-[#f8f9fa]">
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2">
            <span className="text-[#1a73e8]">AdReady</span>
          </h1>
          <p className="text-[13px] text-slate-500 mt-1 font-medium">AI Generation Workspace</p>
        </div>
        <div className="w-full h-px bg-slate-200"></div>

        <div className="p-8 flex flex-col gap-10 flex-1 overflow-y-auto">
          <section>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Product Image</h2>
                <p className="mt-1 text-xs text-slate-500 font-medium">Required. This is the image that will be cleaned and polished.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsBgRemoverOpen(true)}
                  className="text-[11px] font-medium px-4 py-1.5 rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors"
                >
                  BG Remover
                </button>
                <button
                  onClick={handleFillWithAI}
                  className="text-[11px] font-medium px-4 py-1.5 rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
                  disabled={!productImage || isFillingAI}
                >
                  {isFillingAI ? 'Filling...' : 'Fill with AI'}
                </button>
                {productImage && (
                  <button
                    onClick={() => {
                      setProductImage('');
                      setFillValues(null);
                      setFillAnalysisMeta(null);
                      setFillError('');
                      setVideoByCardKey((prev) => {
                        const next = { ...prev };
                        delete next[PRODUCT_VIDEO_CARD_KEY];
                        return next;
                      });
                    }}
                    className="text-[11px] text-red-500 hover:text-red-600 font-bold ml-1 transition-colors"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div className="bg-white rounded-3xl p-1 shadow-sm border border-slate-100">
              <ImageUpload
                imagePreview={productImage}
                onImageSelected={(dataUrl) => {
                  setProductImage(dataUrl);
                  setFillValues(null);
                  setFillAnalysisMeta(null);
                  setErrorMessage('');
                  setFillError('');
                  setVideoByCardKey((prev) => {
                    const next = { ...prev };
                    delete next[PRODUCT_VIDEO_CARD_KEY];
                    return next;
                  });
                }}
                title="Upload product image"
                subtitle="PNG, JPG, or JPEG. Use the cutout or main product photo."
                replaceLabel="Replace Product Image"
              />
            </div>
            {productImage && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={openVideoModalForProductImage}
                  className="inline-flex items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-indigo-700 transition-colors hover:bg-indigo-100 hover:border-indigo-300"
                >
                  Make A Video
                </button>
                {productVideoState && (
                  <p className={`mt-2 text-[11px] font-semibold ${
                    productVideoState.status === 'completed'
                      ? 'text-emerald-600'
                      : productVideoState.status === 'failed'
                        ? 'text-red-500'
                        : 'text-slate-500'
                  }`}>
                    {productVideoState.status === 'completed' && 'Video ready from product image'}
                    {productVideoState.status === 'failed' && (productVideoState.error || 'Video render failed')}
                    {(productVideoState.status === 'queued' || productVideoState.status === 'rendering') && 'Rendering video from product image...'}
                  </p>
                )}
                {renderVideoAnalysisDetails(productVideoState)}
                {productVideoState?.status === 'completed' && productVideoState.videoUrl && (
                  <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50/40 p-3">
                    <video controls className="w-full rounded-lg border border-emerald-100 bg-black" src={productVideoState.videoUrl} />
                    <a
                      href={productVideoState.videoUrl}
                      download="adready-product-video.mp4"
                      className="mt-2 inline-flex items-center justify-center rounded-full border border-emerald-200 bg-white px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-emerald-700 hover:bg-emerald-100 transition-colors"
                    >
                      Download Video
                    </a>
                  </div>
                )}
                {productVideoState?.status === 'failed' && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={openVideoModalForProductImage}
                      className="inline-flex items-center justify-center rounded-full border border-red-200 bg-white px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-red-600 hover:bg-red-50 transition-colors"
                    >
                      Retry Video Render
                    </button>
                  </div>
                )}
              </div>
            )}
            {fillError && (
              <p className="mt-3 text-xs font-medium text-red-500 bg-red-50 px-3 py-2 rounded-lg border border-red-100">{fillError}</p>
            )}
            {fillAnalysisMeta && (
              <div className={`mt-3 rounded-lg border px-3 py-2 ${
                fillGatePassed
                  ? 'border-emerald-100 bg-emerald-50'
                  : 'border-amber-200 bg-amber-50'
              }`}>
                <p className={`text-xs font-semibold ${
                  fillGatePassed ? 'text-emerald-700' : 'text-amber-800'
                }`}>
                  Fill Quality {hasFillQualityScore ? `· ${fillQualityScore}/100` : ''}
                  {fillGatePassed ? ' · Passed' : ' · Needs Review'}
                </p>
                <p className="mt-1 text-[11px] text-slate-600">
                  {fillGatePassed
                    ? 'Gemini returned a high-confidence creative plan and auto-filled your prompt fields.'
                    : 'Gemini returned a best-effort plan. Review fields before generating.'}
                </p>
                {!fillGatePassed && fillFailureReasons.length > 0 && (
                  <p className="mt-1 text-[11px] text-amber-800">
                    {fillFailureReasons.slice(0, 2).join(' ')}
                  </p>
                )}
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">Reference Image (Optional)</h2>
                <p className="mt-1 text-xs text-slate-500 font-medium">Used only to guide the background, mood, and scene styling.</p>
              </div>
              {referenceImage && (
                <div className="flex flex-col items-end gap-2">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => {
                        setIsReferenceTest2Open(false);
                        setIsReferenceTestOpen(true);
                      }}
                      className="text-[11px] font-medium px-4 py-1.5 rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => {
                        setIsReferenceTestOpen(false);
                        setIsReferenceTest2Open(true);
                      }}
                      className="text-[11px] font-medium px-4 py-1.5 rounded-full border border-slate-200 text-slate-600 bg-white hover:bg-slate-50 transition-colors"
                    >
                      Test 2
                    </button>
                  </div>
                  <button
                    onClick={() => {
                      setReferenceImage('');
                      setReferencePipelineStatus({
                        title: REFERENCE_PIPELINE_LABEL,
                        step: 'idle',
                        message: 'Ready. Click Generate Design to run the pipeline.',
                      });
                      setIsReferenceTestOpen(false);
                      setIsReferenceTest2Open(false);
                      setReferenceTestLoadingProvider('');
                      setReferenceRecreateProvider('');
                      setReferenceAddProductProvider('');
                      setReferenceTestError('');
                      setReferenceTestResults({});
                      setReferenceTest2LoadingProvider('');
                      setReferenceRecreate2Provider('');
                      setReferenceAddProduct2Provider('');
                      setReferenceTest2Error('');
                      setReferenceTest2Results({});
                    }}
                    className="text-[11px] text-red-500 hover:text-red-600 font-bold transition-colors"
                  >
                    Clear
                  </button>
                </div>
              )}
            </div>
            <div className="bg-white rounded-3xl p-1 shadow-sm border border-slate-100">
              <ImageUpload
                imagePreview={referenceImage}
                onImageSelected={(dataUrl) => {
                  setReferenceImage(dataUrl);
                  setErrorMessage('');
                  setReferencePipelineStatus({
                    title: REFERENCE_PIPELINE_LABEL,
                    step: 'idle',
                    message: 'Ready. Click Generate Design to run the pipeline.',
                  });
                  setIsReferenceTestOpen(false);
                  setIsReferenceTest2Open(false);
                  setReferenceTestLoadingProvider('');
                  setReferenceRecreateProvider('');
                  setReferenceAddProductProvider('');
                  setReferenceTestError('');
                  setReferenceTestResults({});
                  setReferenceTest2LoadingProvider('');
                  setReferenceRecreate2Provider('');
                  setReferenceAddProduct2Provider('');
                  setReferenceTest2Error('');
                  setReferenceTest2Results({});
                }}
                title="Upload optional reference"
                subtitle="Guides the background only. Leave empty to let AI choose the scene."
                replaceLabel="Replace Reference"
              />
            </div>
            <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
              <label className="flex items-start justify-between gap-3 cursor-pointer">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Strict Reference Lock</p>
                  <p className="mt-1 text-[11px] text-slate-500 leading-relaxed">
                    Preserve original reference background and camera perspective. Uses strict compositing placement.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={strictReferenceLock}
                  onClick={() => {
                    if (referenceImage) {
                      setStrictReferenceLock((prev) => !prev);
                    }
                  }}
                  disabled={!referenceImage}
                  className={`relative w-11 h-6 rounded-full transition-colors border ${
                    strictReferenceLock && referenceImage
                      ? 'bg-indigo-500 border-indigo-500'
                      : 'bg-slate-200 border-slate-200'
                  } ${!referenceImage ? 'opacity-50 cursor-not-allowed' : ''}`}
                >
                  <span
                    className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-transform ${
                      strictReferenceLock && referenceImage ? 'translate-x-5' : 'translate-x-0.5'
                    }`}
                  />
                </button>
              </label>
            </div>
          </section>

          <section>
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4">Prompt</h2>
            {!productImage && (
              <p className="mb-4 text-xs font-medium text-amber-700 bg-amber-50 px-3 py-2 rounded-lg border border-amber-100">
                Upload a product image first. Reference image is optional.
              </p>
            )}
            <PromptInput
              onGenerate={handleGenerate}
              isGenerating={isGenerating || isFillingAI}
              fillValues={fillValues}
              hasReferenceImage={Boolean(referenceImage)}
              referencePipelineStatus={referencePipelineStatus}
            />
          </section>

        </div>

        <div className="px-8 py-6 border-t border-slate-200 bg-white relative">
          
          {isProfileMenuOpen && (
            <div className="absolute bottom-[80px] left-4 right-4 bg-white rounded-2xl shadow-[0_8px_30px_rgba(0,0,0,0.08)] border border-slate-100 p-5 z-20 flex flex-col gap-5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Theme</span>
                <div className="w-12 h-6 bg-[#6ea8ff] rounded-full relative cursor-pointer">
                  <div className="absolute top-1 right-1 w-4 h-4 bg-white rounded-full flex items-center justify-center shadow-sm">
                    <svg className="w-3 h-3 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
                  </div>
                </div>
              </div>
              
              <div className="flex items-center justify-between bg-slate-50/50 rounded-xl p-4 border border-slate-100">
                <div className="flex items-center gap-3">
                  <div className="w-2.5 h-2.5 rounded-full bg-red-400 shadow-[0_0_0_4px_rgba(248,113,113,0.15)]"></div>
                  <div>
                    <p className="text-xs font-bold text-slate-700">SYSTEM STATUS</p>
                    <p className="text-[11px] text-slate-500 mt-0.5">No Accounts Connected</p>
                  </div>
                </div>
                <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </div>

              <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-100">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-[#dcf2ff] text-[#1a73e8] font-bold flex items-center justify-center text-lg">
                    {userInitial}
                  </div>
                  <p className="text-slate-800 font-bold text-sm">{currentUser}</p>
                </div>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="flex items-center gap-2 text-slate-500 hover:text-slate-800 font-medium transition-colors text-sm"
                >
                  <span>Sign Out</span>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H10m7 7v1a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1"></path></svg>
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div 
              className="flex items-center gap-3 cursor-pointer group"
              onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
            >
              <div className="w-10 h-10 rounded-full bg-[#dcf2ff] text-[#1a73e8] font-bold flex items-center justify-center text-lg flex-shrink-0 group-hover:scale-105 transition-transform">
                {userInitial}
              </div>
              <p className="text-slate-800 font-bold text-sm">{currentUser}</p>
            </div>
            <div className="flex items-center gap-4 text-slate-500">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="hover:text-slate-800 transition-colors"
                title="Settings"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="flex items-center gap-1.5 hover:text-slate-800 transition-colors text-sm font-medium ml-2"
              >
                <span>Sign Out</span>
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 16l4-4m0 0l-4-4m4 4H10m7 7v1a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>

      <main className="flex-1 bg-transparent h-full overflow-y-auto flex flex-col relative z-10 selection:bg-indigo-500/30">
        {generatedResults.length > 0 ? (
          <div className="flex-1 flex flex-col p-8 items-center justify-center min-h-0">
            <div className="relative w-full max-w-5xl max-h-full flex flex-col items-center">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full">
                {generatedResults.map((result, index) => {
                  const cardKey = getResultCardKey(index, result);
                  const videoState = videoByCardKey[cardKey] || null;
                  return (
                  <div
                    key={`${result.imageUrl}-${index}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectResult(index, result)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleSelectResult(index, result);
                      }
                    }}
                    className={`group text-left bg-white/70 backdrop-blur-xl p-3 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border transition-all duration-300 focus:outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/30 ${
                      selectedIndex === index
                        ? 'border-indigo-500 ring-4 ring-indigo-500/10 shadow-[0_20px_40px_-15px_rgba(99,102,241,0.2)]'
                        : 'border-white hover:border-indigo-200 hover:shadow-[0_20px_40px_-15px_rgba(0,0,0,0.05)]'
                    }`}
                  >
                    <div className="relative overflow-hidden rounded-2xl bg-slate-100">
                      <button
                        type="button"
                        className="block w-full text-left"
                        onClick={(event) => {
                          event.stopPropagation();
                          openImageInNewTab(result.imageUrl);
                        }}
                      >
                        <img
                          src={result.imageUrl}
                          alt={`Generated result ${index + 1}`}
                          className="rounded-2xl max-h-[60vh] object-contain w-full transition-transform duration-500 group-hover:scale-[1.02]"
                        />
                      </button>
                      <div className="absolute inset-0 rounded-2xl bg-slate-900/40 opacity-0 transition-opacity duration-300 group-hover:opacity-100 flex items-center justify-center gap-4 backdrop-blur-[2px]">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openImageInNewTab(result.imageUrl);
                          }}
                          className="px-5 py-2.5 text-xs font-bold uppercase tracking-widest rounded-full bg-white text-slate-900 shadow-xl hover:bg-slate-50 hover:scale-105 transition-all"
                        >
                          Open
                        </button>
                        <a
                          href={result.imageUrl}
                          download={`adready-option-${index + 1}.png`}
                          onClick={(event) => event.stopPropagation()}
                          className="px-5 py-2.5 text-xs font-bold uppercase tracking-widest rounded-full bg-slate-900 text-white shadow-xl hover:bg-slate-800 hover:scale-105 transition-all"
                        >
                          Download
                        </a>
                      </div>
                    </div>
                    <div className="mt-5 px-4 pb-3">
                      <div className="flex items-center gap-2 mb-2.5">
                        <div className={`w-2 h-2 rounded-full ${selectedIndex === index ? 'bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]' : 'bg-slate-300'}`} />
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                          {result?.resultLabel || `Generation ${index + 1}`}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openVideoModalForCard(index);
                        }}
                        className="inline-flex items-center justify-center rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-indigo-700 transition-colors hover:bg-indigo-100 hover:border-indigo-300"
                      >
                        Make A Video
                      </button>
                      {videoState && (
                        <p className={`mt-2 text-[10px] font-semibold ${
                          videoState.status === 'completed'
                            ? 'text-emerald-600'
                            : videoState.status === 'failed'
                              ? 'text-red-500'
                              : 'text-slate-500'
                        }`}>
                          {videoState.status === 'completed' && `Video ready${videoState.presetUsed ? ` (${videoState.presetUsed})` : ''}`}
                          {videoState.status === 'failed' && (videoState.error || 'Video failed')}
                          {(videoState.status === 'queued' || videoState.status === 'rendering') && 'Rendering video...'}
                        </p>
                      )}
                    </div>
                  </div>
                )})}
              </div>

              {selectedResult && (
                <div className="mt-10 max-w-3xl text-center bg-white/60 backdrop-blur-xl p-8 rounded-3xl border border-white shadow-[0_8px_30px_rgb(0,0,0,0.04)]">
                  {referenceMode === 'openai' && editInstruction && (
                    <p className="mt-4 text-sm font-mono text-slate-500 bg-slate-100/50 inline-block px-4 py-2 rounded-xl border border-slate-200/50">
                      Instruction: {editInstruction}
                    </p>
                  )}
                  {errorMessage && (
                    <p className="mt-4 text-red-500 text-sm font-bold bg-red-50 py-2 px-5 rounded-xl border border-red-100 inline-block">
                      {errorMessage}
                    </p>
                  )}
                  {selectedVideoState?.status === 'completed' && selectedVideoState.videoUrl && (
                    <div className="mt-5 text-left rounded-2xl border border-emerald-100 bg-emerald-50/60 p-4">
                      <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-600">
                        Video Ready
                      </p>
                      <video
                        controls
                        className="mt-2 w-full rounded-xl border border-emerald-100 bg-black"
                        src={selectedVideoState.videoUrl}
                      />
                      <a
                        href={selectedVideoState.videoUrl}
                        download={`adready-video-option-${selectedIndex + 1}.mp4`}
                        className="mt-3 inline-flex items-center justify-center rounded-full border border-emerald-200 bg-white px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-emerald-700 hover:bg-emerald-100 transition-colors"
                      >
                        Download Video
                      </a>
                    </div>
                  )}
                  {(selectedVideoState?.status === 'queued' || selectedVideoState?.status === 'rendering') && (
                    <p className="mt-4 text-slate-600 text-xs font-semibold bg-slate-100 py-2 px-4 rounded-xl border border-slate-200 inline-block">
                      Rendering video in progress...
                    </p>
                  )}
                  {selectedVideoState?.status === 'failed' && (
                    <div className="mt-4">
                      <p className="text-red-500 text-xs font-semibold bg-red-50 py-2 px-4 rounded-xl border border-red-100 inline-block">
                        {selectedVideoState.error || 'Video render failed'}
                      </p>
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => openVideoModalForCard(selectedIndex)}
                          className="inline-flex items-center justify-center rounded-full border border-red-200 bg-white px-4 py-2 text-[11px] font-bold uppercase tracking-widest text-red-600 hover:bg-red-50 transition-colors"
                        >
                          Retry Video Render
                        </button>
                      </div>
                    </div>
                  )}
                  {renderVideoAnalysisDetails(selectedVideoState)}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-slate-400 p-8">
            <div className="w-full max-w-5xl">
              <div className="flex flex-col items-center text-center mb-8">
                <div className="relative group">
                  <div className="absolute inset-0 bg-indigo-500/20 blur-xl rounded-full group-hover:bg-indigo-500/30 transition-colors duration-500" />
                  <div className={`w-24 h-24 bg-white/80 backdrop-blur-sm border border-white shadow-xl rounded-[2rem] flex items-center justify-center mb-6 relative z-10 rotate-3 group-hover:rotate-6 transition-transform duration-500 ${isGenerating ? 'animate-pulse' : ''}`}>
                    <svg className="w-10 h-10 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                    </svg>
                  </div>
                </div>
                <h3 className="text-3xl font-bold text-slate-800 mb-3 tracking-tight">
                  {isGenerating ? 'Generating Concepts...' : 'Ready to Generate'}
                </h3>
                <p className="max-w-md text-base text-slate-500 leading-relaxed font-medium">
                  {isGenerating
                    ? 'Creating two options now. Your cards will update automatically in a moment.'
                    : 'Upload a product image, optionally add a reference image, and type a prompt to get started with AdReady.'}
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full">
                {[1, 2].map((cardNumber) => (
                  <div
                    key={cardNumber}
                    className={`text-left bg-white/70 backdrop-blur-xl p-3 rounded-3xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-white transition-all duration-300 ${
                      isGenerating ? 'border-indigo-100 shadow-[0_14px_34px_-16px_rgba(99,102,241,0.35)]' : ''
                    }`}
                  >
                    <div className={`rounded-2xl h-[340px] md:h-[420px] border border-dashed border-slate-200 flex items-center justify-center transition-all duration-500 ${
                      isGenerating ? 'bg-slate-100 animate-pulse' : 'bg-gradient-to-br from-white to-slate-100/80'
                    }`}>
                      <div className={`w-24 h-24 rounded-3xl border border-slate-200 bg-white/80 shadow-[0_12px_24px_-12px_rgba(99,102,241,0.4)] flex items-center justify-center ${
                        isGenerating ? 'animate-pulse' : ''
                      }`}>
                        <svg className={`w-10 h-10 text-indigo-300 ${isGenerating ? 'animate-pulse' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path>
                        </svg>
                      </div>
                    </div>

                    <div className="mt-5 px-4 pb-3">
                      <div className="flex items-center gap-2 mb-3">
                        <div className={`w-2 h-2 rounded-full ${isGenerating ? 'bg-indigo-400 animate-pulse' : 'bg-slate-300'}`} />
                        <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Generation {cardNumber}</p>
                      </div>
                      <div className="space-y-2">
                        <div className={`h-3 rounded-full w-full ${isGenerating ? 'bg-slate-200 animate-pulse' : 'bg-slate-200/80'}`} />
                        <div className={`h-3 rounded-full w-11/12 ${isGenerating ? 'bg-slate-200 animate-pulse' : 'bg-slate-200/70'}`} />
                        <div className={`h-3 rounded-full w-8/12 ${isGenerating ? 'bg-slate-200 animate-pulse' : 'bg-slate-200/60'}`} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </main>

    </div>
      {isReferenceTestOpen && referenceImage && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close reference test"
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]"
            onClick={() => setIsReferenceTestOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.45)]"
          >
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Reference Read Test</p>
              <button
                type="button"
                onClick={() => setIsReferenceTestOpen(false)}
                className="w-8 h-8 rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
              >
                x
              </button>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <img
                src={referenceImage}
                alt="Reference test preview"
                className="w-full max-h-[420px] object-contain"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleReferenceReadTest('openai')}
                disabled={
                  Boolean(referenceTestLoadingProvider) ||
                  Boolean(referenceRecreateProvider) ||
                  Boolean(referenceAddProductProvider) ||
                  isGenerating
                }
                className="text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                {referenceTestLoadingProvider === 'openai' ? 'Reading...' : 'Read with ChatGPT'}
              </button>
              <button
                type="button"
                onClick={() => handleReferenceReadTest('gemini')}
                disabled={
                  Boolean(referenceTestLoadingProvider) ||
                  Boolean(referenceRecreateProvider) ||
                  Boolean(referenceAddProductProvider) ||
                  isGenerating
                }
                className="text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                {referenceTestLoadingProvider === 'gemini' ? 'Reading...' : 'Read with Gemini'}
              </button>
            </div>
            {referenceTestError && (
              <p className="mt-3 text-xs font-medium text-red-500 bg-red-50 px-3 py-2 rounded-lg border border-red-100">
                {referenceTestError}
              </p>
            )}
            {(referenceTestResults.openai || referenceTestResults.gemini) && (
              <div className="mt-4 grid grid-cols-1 gap-3">
                {['openai', 'gemini'].map((provider) => {
                  const providerResult = referenceTestResults[provider];
                  if (!providerResult) {
                    return null;
                  }
                  const providerLabel = provider === 'openai' ? 'ChatGPT' : 'Gemini';
                  const canRecreate = Boolean(String(providerResult?.builtPrompt || '').trim());
                  return (
                    <div key={provider} className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                        {providerLabel}
                      </p>
                      {providerResult?.scenePlan?.displayText && (
                        <p className="mt-2 text-xs text-slate-700 leading-relaxed">
                          {providerResult.scenePlan.displayText}
                        </p>
                      )}
                      <p className="mt-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        Built Prompt
                      </p>
                      <p className="mt-1 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed bg-white border border-slate-200 rounded-lg p-2">
                        {providerResult.builtPrompt || 'No prompt returned.'}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleReferenceRecreate(provider)}
                        disabled={
                          !canRecreate ||
                          Boolean(referenceTestLoadingProvider) ||
                          Boolean(referenceRecreateProvider) ||
                          Boolean(referenceAddProductProvider) ||
                          isGenerating
                        }
                        className="mt-3 text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
                      >
                        {referenceRecreateProvider === provider ? 'Recreating...' : 'Recreate the Image'}
                      </button>
                      {providerResult?.recreatedImageUrl && (
                        <div className="mt-3">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                            Recreated Image
                          </p>
                          <div className="mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
                            <button
                              type="button"
                              className="block w-full text-left"
                              title="Open full image"
                              onClick={() => openImageInNewTab(providerResult.recreatedImageUrl)}
                            >
                              <img
                                src={providerResult.recreatedImageUrl}
                                alt={`${providerLabel} recreated preview`}
                                className="w-full max-h-[260px] object-contain cursor-zoom-in"
                              />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => openImageInNewTab(providerResult.recreatedImageUrl)}
                            className="mt-1 inline-block text-[10px] font-medium text-slate-600 hover:text-slate-800 underline"
                          >
                            Open Full
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReferenceAddProduct(provider)}
                            disabled={
                              !productImage ||
                              Boolean(referenceTestLoadingProvider) ||
                              Boolean(referenceRecreateProvider) ||
                              Boolean(referenceAddProductProvider) ||
                              isGenerating
                            }
                            className="mt-2 text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
                          >
                            {referenceAddProductProvider === provider ? 'Adding Product...' : 'Add My Product'}
                          </button>
                          {providerResult?.productAddedImageUrl && (
                            <div className="mt-3">
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                With My Product
                              </p>
                              <div className="mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
                                <button
                                  type="button"
                                  className="block w-full text-left"
                                  title="Open full image"
                                  onClick={() => openImageInNewTab(providerResult.productAddedImageUrl)}
                                >
                                  <img
                                    src={providerResult.productAddedImageUrl}
                                    alt={`${providerLabel} with product preview`}
                                    className="w-full max-h-[260px] object-contain cursor-zoom-in"
                                  />
                                </button>
                              </div>
                              <button
                                type="button"
                                onClick={() => openImageInNewTab(providerResult.productAddedImageUrl)}
                                className="mt-1 inline-block text-[10px] font-medium text-slate-600 hover:text-slate-800 underline"
                              >
                                Open Full
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {isReferenceTest2Open && referenceImage && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close reference test 2"
            className="absolute inset-0 bg-slate-900/45 backdrop-blur-[2px]"
            onClick={() => setIsReferenceTest2Open(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative z-10 w-full max-w-3xl max-h-[88vh] overflow-y-auto rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.45)]"
          >
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">Reference Read Test 2</p>
              <button
                type="button"
                onClick={() => setIsReferenceTest2Open(false)}
                className="w-8 h-8 rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 transition-colors"
              >
                x
              </button>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <img
                src={referenceImage}
                alt="Reference test 2 preview"
                className="w-full max-h-[420px] object-contain"
              />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleReferenceReadTest2('openai')}
                disabled={
                  Boolean(referenceAutoFlow2Provider) ||
                  Boolean(referenceTest2LoadingProvider) ||
                  Boolean(referenceRecreate2Provider) ||
                  Boolean(referenceAddProduct2Provider) ||
                  isGenerating
                }
                className="text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                {referenceTest2LoadingProvider === 'openai' ? 'Reading...' : 'Read with ChatGPT'}
              </button>
              <button
                type="button"
                onClick={() => handleReferenceReadTest2('gemini')}
                disabled={
                  Boolean(referenceAutoFlow2Provider) ||
                  Boolean(referenceTest2LoadingProvider) ||
                  Boolean(referenceRecreate2Provider) ||
                  Boolean(referenceAddProduct2Provider) ||
                  isGenerating
                }
                className="text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                {referenceTest2LoadingProvider === 'gemini' ? 'Reading...' : 'Read with Gemini'}
              </button>
              <button
                type="button"
                onClick={() => handleReferenceAutoFlow2('gemini')}
                disabled={
                  !productImage ||
                  Boolean(referenceAutoFlow2Provider) ||
                  Boolean(referenceTest2LoadingProvider) ||
                  Boolean(referenceRecreate2Provider) ||
                  Boolean(referenceAddProduct2Provider) ||
                  isGenerating
                }
                className="text-[11px] font-semibold px-4 py-2 rounded-full border border-indigo-200 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 transition-colors disabled:opacity-50"
              >
                {referenceAutoFlow2Provider === 'gemini' ? 'Auto Running...' : 'Auto Run (Gemini)'}
              </button>
            </div>
            {referenceTest2Error && (
              <p className="mt-3 text-xs font-medium text-red-500 bg-red-50 px-3 py-2 rounded-lg border border-red-100">
                {referenceTest2Error}
              </p>
            )}
            {(referenceTest2Results.openai || referenceTest2Results.gemini) && (
              <div className="mt-4 grid grid-cols-1 gap-3">
                {['openai', 'gemini'].map((provider) => {
                  const providerResult = referenceTest2Results[provider];
                  if (!providerResult) {
                    return null;
                  }
                  const providerLabel = provider === 'openai' ? 'ChatGPT' : 'Gemini';
                  const canRecreate = Boolean(String(providerResult?.builtPrompt || '').trim());
                  return (
                    <div key={provider} className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                      <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">
                        {providerLabel}
                      </p>
                      {providerResult?.scenePlan?.displayText && (
                        <p className="mt-2 text-xs text-slate-700 leading-relaxed">
                          {providerResult.scenePlan.displayText}
                        </p>
                      )}
                      <p className="mt-3 text-[10px] font-bold uppercase tracking-widest text-slate-400">
                        Built Prompt
                      </p>
                      <p className="mt-1 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed bg-white border border-slate-200 rounded-lg p-2">
                        {providerResult.builtPrompt || 'No prompt returned.'}
                      </p>
                      <button
                        type="button"
                        onClick={() => handleReferenceRecreate2(provider)}
                        disabled={
                          !canRecreate ||
                          Boolean(referenceAutoFlow2Provider) ||
                          Boolean(referenceTest2LoadingProvider) ||
                          Boolean(referenceRecreate2Provider) ||
                          Boolean(referenceAddProduct2Provider) ||
                          isGenerating
                        }
                        className="mt-3 text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
                      >
                        {referenceRecreate2Provider === provider ? 'Recreating...' : 'Recreate the Image'}
                      </button>
                      {providerResult?.recreatedImageUrl && (
                        <div className="mt-3">
                          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                            Recreated Image
                          </p>
                          <div className="mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
                            <button
                              type="button"
                              className="block w-full text-left"
                              title="Open full image"
                              onClick={() => openImageInNewTab(providerResult.recreatedImageUrl)}
                            >
                              <img
                                src={providerResult.recreatedImageUrl}
                                alt={`${providerLabel} recreated preview`}
                                className="w-full max-h-[260px] object-contain cursor-zoom-in"
                              />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => openImageInNewTab(providerResult.recreatedImageUrl)}
                            className="mt-1 inline-block text-[10px] font-medium text-slate-600 hover:text-slate-800 underline"
                          >
                            Open Full
                          </button>
                          <button
                            type="button"
                            onClick={() => handleReferenceAddProduct2(provider)}
                            disabled={
                              !productImage ||
                              Boolean(referenceAutoFlow2Provider) ||
                              Boolean(referenceTest2LoadingProvider) ||
                              Boolean(referenceRecreate2Provider) ||
                              Boolean(referenceAddProduct2Provider) ||
                              isGenerating
                            }
                            className="mt-2 text-[11px] font-medium px-4 py-2 rounded-full border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 transition-colors disabled:opacity-50"
                          >
                            {referenceAddProduct2Provider === provider ? 'Adding Product...' : 'Add My Product'}
                          </button>
                          {providerResult?.productAddedImageUrl && (
                            <div className="mt-3">
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                                With My Product
                              </p>
                              <div className="mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white">
                                <button
                                  type="button"
                                  className="block w-full text-left"
                                  title="Open full image"
                                  onClick={() => openImageInNewTab(providerResult.productAddedImageUrl)}
                                >
                                  <img
                                    src={providerResult.productAddedImageUrl}
                                    alt={`${providerLabel} with product preview`}
                                    className="w-full max-h-[260px] object-contain cursor-zoom-in"
                                  />
                                </button>
                              </div>
                              <button
                                type="button"
                                onClick={() => openImageInNewTab(providerResult.productAddedImageUrl)}
                                className="mt-1 inline-block text-[10px] font-medium text-slate-600 hover:text-slate-800 underline"
                              >
                                Open Full
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {isVideoModalOpen && videoModalResult && (
        <div className="fixed inset-0 z-[85] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close video preset modal"
            className="absolute inset-0 bg-slate-900/50 backdrop-blur-[2px]"
            onClick={closeVideoModal}
          />
          <div className="relative z-10 w-full max-w-md rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_24px_60px_-20px_rgba(15,23,42,0.45)]">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
                Make A Video
              </p>
              <button
                type="button"
                onClick={closeVideoModal}
                disabled={isSubmittingVideoRender}
                className="w-8 h-8 rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 transition-colors disabled:opacity-40"
              >
                x
              </button>
            </div>
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              <img
                src={videoModalResult.imageUrl}
                alt="Video source preview"
                className="w-full max-h-[260px] object-contain"
              />
            </div>
            <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-slate-400">Preset</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {VIDEO_PRESET_OPTIONS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setVideoPresetMode(preset.value)}
                  className={`rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${
                    videoPresetMode === preset.value
                      ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                      : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={handleSubmitVideoRender}
              disabled={isSubmittingVideoRender}
              className="mt-5 w-full rounded-2xl bg-indigo-600 px-4 py-3 text-sm font-bold text-white hover:bg-indigo-500 transition-colors disabled:opacity-60"
            >
              {isSubmittingVideoRender ? 'Starting Render...' : 'Generate Video'}
            </button>
          </div>
        </div>
      )}
      <BgRemoverModal
        isOpen={isBgRemoverOpen}
        onClose={() => setIsBgRemoverOpen(false)}
        authToken={localStorage.getItem('authToken') || ''}
      />
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        authToken={localStorage.getItem('authToken') || ''}
        fallbackUsername={currentUser}
        fallbackRole={currentRole}
        onProfileUpdated={(user) => {
          if (user?.username) {
            setCurrentUser(user.username);
          }
          if (user?.role) {
            setCurrentRole(user.role);
          }
        }}
      />
    </>
  );
}

export default Dashboard;
