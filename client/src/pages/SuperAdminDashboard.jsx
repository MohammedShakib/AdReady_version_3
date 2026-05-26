import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sun,
  Moon,
  LogOut,
  Users,
  FileText,
  Clock,
  AlertTriangle,
  Database,
  Plus,
  Edit2,
  Trash2,
  X,
  RefreshCw,
  Loader2,
  Send,
  CreditCard,
  Bot,
  Sparkles,
  Mail,
  Eye,
  EyeOff,
  Save,
  Clipboard,
  Download,
} from 'lucide-react';
import { apiUrl } from '../lib/api';

const TAB_LIST = ['Users', 'Connections', 'API', 'API Log', 'Presets', 'Plans', 'Top Ups', 'Histroy'];
const ADMIN_ACTIVE_TAB_STORAGE_KEY = 'superAdminActiveTab';
const DEV_AUTH_BYPASS_ENABLED = String(import.meta.env.VITE_ALLOW_DEV_AUTH_BYPASS || '').toLowerCase() === 'true';
const DEV_AUTH_BYPASS_LOGOUT_FLAG_KEY = 'devAuthBypassLoggedOut';
const safeStorage = {
  get(key) {
    try {
      if (typeof window === 'undefined') return null;
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (typeof window === 'undefined') return false;
      window.localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try {
      if (typeof window === 'undefined') return false;
      window.localStorage.removeItem(key);
      return true;
    } catch {
      return false;
    }
  },
};
const PLAN_TIERS = ['free', 'basic', 'pro'];
const PLAN_OPTIONS = PLAN_TIERS.map((tier) => ({ value: tier, label: tier[0].toUpperCase() + tier.slice(1) }));
const ROLE_OPTIONS = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];
const PLAN_DEFAULT_CREDITS = {
  free: 5,
  basic: 100,
  pro: 250,
};
const PLAN_DEFAULT_PRICES = {
  free: 0,
  basic: 30,
  pro: 50,
};
const PLAN_DEFAULT_NAMES = {
  free: 'Free',
  basic: 'Basic',
  pro: 'Pro',
};
const TOPUP_DEFAULT_PACKAGES = [
  { credits: 25, priceUsd: 7.5, isActive: true, sortOrder: 1 },
  { credits: 50, priceUsd: 15, isActive: true, sortOrder: 2 },
  { credits: 100, priceUsd: 30, isActive: true, sortOrder: 3 },
];
const PLAN_LIMIT_PRESETS = {
  free: { pages: 1, ai: 5 },
  basic: { pages: 3, ai: 20 },
  pro: { pages: 10, ai: 100 },
};
const GENERATE_PIPELINE_OPTIONS = [
  'gemini-edit-pipeline',
  'reference-img-pipeline-1',
  'openai-image-pipeline',
];
const ANALYZE_PIPELINE_OPTIONS = [
  'gemini-edit-pipeline',
  'openai-analyze-pipeline',
];
const PIPELINE_DISPLAY_NAME_MAP = {
  'reference-img-pipeline-1': 'Reference-img-pipeline-1',
  'gemini-reference-guided-pipeline': 'Reference-img-pipeline-1',
};

const getPipelineDisplayName = (pipeline) => {
  const token = String(pipeline || '').trim().toLowerCase();
  return PIPELINE_DISPLAY_NAME_MAP[token] || token || '-';
};

const formatDate = (value, fallback = '-') => {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString();
};

const formatTime = (value, fallback = '-') => {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? fallback
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const toPrettyJson = (value) => {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value ?? '');
  }
};

const resolveApiDocsBaseUrl = (candidateUrl = '') => {
  const urlText = String(candidateUrl || '').trim();
  if (!urlText) return 'https://your-api-domain.com';
  try {
    return new URL(urlText).origin;
  } catch {
    return 'https://your-api-domain.com';
  }
};

const buildDefaultForm = () => ({
  username: '',
  email: '',
  password: '',
  role: 'member',
  planTier: 'free',
  credits: String(PLAN_DEFAULT_CREDITS.free),
  isActive: true,
});

const buildFallbackPlans = () =>
  PLAN_OPTIONS.map((item) => ({
    tier: item.value,
    name: PLAN_DEFAULT_NAMES[item.value] || item.label,
    priceUsdMonthly: PLAN_DEFAULT_PRICES[item.value] ?? 0,
    monthlyCredits: PLAN_DEFAULT_CREDITS[item.value] ?? 0,
    isEditable: true,
  }));

const buildFallbackTopups = () =>
  TOPUP_DEFAULT_PACKAGES.map((item, index) => ({
    credits: Number(item.credits || 0),
    priceUsd: Number(item.priceUsd || 0),
    isActive: item.isActive !== false,
    sortOrder: Number(item.sortOrder || index + 1),
  }));

const buildDefaultConnections = () => ({
  telegram: {
    provider: 'telegram',
    isEnabled: false,
    config: {
      bot_username: '',
      bot_token: '',
      mode: 'polling',
      webhook_path: '/webhook',
      public_server_url: '',
    },
  },
  stripe: {
    provider: 'stripe',
    isEnabled: false,
    config: {
      publishable_key: '',
      secret_key: '',
      webhook_secret: '',
      payment_redirect_url: '',
    },
  },
  openai: {
    provider: 'openai',
    isEnabled: false,
    config: {
      api_key: '',
      model: 'gpt-4o',
      image_model: 'gpt-image-1',
      base_url: '',
      text_url: '',
    },
  },
  gemini: {
    provider: 'gemini',
    isEnabled: false,
    config: {
      api_key: '',
      model: 'gemini-2.5-flash',
      text_model: '',
      vision_model: '',
      image_model: 'gemini-2.5-flash-image',
      image_url: '',
      image_fallback_url: '',
      image_mime: 'image/png',
    },
  },
  smtp: {
    provider: 'smtp',
    isEnabled: false,
    config: {
      host: '',
      port: '465',
      secure: 'true',
      user: '',
      pass: '',
      from: '',
    },
  },
});

const buildDefaultProjectApiState = () => ({
  projects: [],
  apis: [],
  policies: [],
  runtimeSettings: {
    externalGenerateEnabled: true,
    externalAnalyzeEnabled: true,
  },
  sharedEndpointPath: '/api/external/generate',
  sharedEndpointUrl: '/api/external/generate',
  sharedAnalyzeEndpointPath: '/api/external/analyze',
  sharedAnalyzeEndpointUrl: '/api/external/analyze',
  pipelineCatalog: {
    generate: [...GENERATE_PIPELINE_OPTIONS],
    analyze: [...ANALYZE_PIPELINE_OPTIONS],
  },
});

const buildDefaultManualProjectForm = () => ({
  name: '',
  description: '',
});

const sanitizePipelineList = (value, fallback) => {
  const source = Array.isArray(value) ? value : [];
  const deduped = [];
  for (const item of source) {
    const token = String(item || '').trim().toLowerCase();
    if (!token) continue;
    if (deduped.includes(token)) continue;
    deduped.push(token);
  }
  if (deduped.length) return deduped;
  return [...fallback];
};

const sanitizePipelineSelection = (value, fallback, universe) => {
  if (!Array.isArray(value)) return [...fallback];
  const deduped = [];
  for (const item of value) {
    const token = String(item || '').trim().toLowerCase();
    if (!token || !universe.includes(token) || deduped.includes(token)) continue;
    deduped.push(token);
  }
  return deduped;
};

const normalizePipelineFallback = (value, fallback, universe) => {
  const token = String(value || '').trim().toLowerCase();
  return universe.includes(token) ? token : fallback;
};

const normalizeRuntimeSettings = (value) => ({
  externalGenerateEnabled: value?.externalGenerateEnabled !== false,
  externalAnalyzeEnabled: value?.externalAnalyzeEnabled !== false,
});

const normalizeProjectPipelinePolicy = (value, projectId = '') => {
  const allowedGeneratePipelines = sanitizePipelineSelection(
    value?.allowedGeneratePipelines,
    GENERATE_PIPELINE_OPTIONS,
    GENERATE_PIPELINE_OPTIONS
  );
  const allowedAnalyzePipelines = sanitizePipelineSelection(
    value?.allowedAnalyzePipelines,
    ANALYZE_PIPELINE_OPTIONS,
    ANALYZE_PIPELINE_OPTIONS
  );

  const defaultGeneratePipeline = normalizePipelineFallback(
    value?.defaultGeneratePipeline,
    GENERATE_PIPELINE_OPTIONS[0],
    GENERATE_PIPELINE_OPTIONS
  );
  const defaultAnalyzePipeline = normalizePipelineFallback(
    value?.defaultAnalyzePipeline,
    ANALYZE_PIPELINE_OPTIONS[0],
    ANALYZE_PIPELINE_OPTIONS
  );

  return {
    projectId: String(value?.projectId || projectId || ''),
    defaultGeneratePipeline,
    allowedGeneratePipelines,
    allowGenerateOverride: value?.allowGenerateOverride !== false,
    defaultAnalyzePipeline,
    allowedAnalyzePipelines,
    allowAnalyzeOverride: value?.allowAnalyzeOverride !== false,
    updatedAt: value?.updatedAt || null,
  };
};

const writeTextToClipboard = async (text) => {
  const value = String(text || '');
  if (!value) return false;
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return true;
  }
  const fallback = document.createElement('textarea');
  fallback.value = value;
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.appendChild(fallback);
  fallback.focus();
  fallback.select();
  const didCopy = document.execCommand('copy');
  document.body.removeChild(fallback);
  return didCopy;
};

const shouldShowProjectInApiSection = (project) => {
  const sourceType = String(project?.sourceType || '').toLowerCase();
  const name = String(project?.name || '').trim();
  if (sourceType === 'telegram') return false;
  if (/^telegram upload/i.test(name)) return false;
  return true;
};

const getPlanLimitsForDisplay = (tier, monthlyCredits) => {
  const preset = PLAN_LIMIT_PRESETS[tier] || PLAN_LIMIT_PRESETS.free;
  return {
    posts: Number(monthlyCredits || 0),
    pages: preset.pages,
    ai: preset.ai,
  };
};

const getInitialAdminTab = () => {
  if (typeof window === 'undefined') return 'Users';
  const savedTab = String(safeStorage.get(ADMIN_ACTIVE_TAB_STORAGE_KEY) || '');
  return TAB_LIST.includes(savedTab) ? savedTab : 'Users';
};

const normalizeTopupDraftRows = (rows = []) =>
  (Array.isArray(rows) ? rows : [])
    .map((item, index) => ({
      credits: String(item?.credits ?? ''),
      priceUsd: String(item?.priceUsd ?? ''),
      isActive: item?.isActive !== false,
      sortOrder: Number(item?.sortOrder || index + 1),
    }))
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));

export default function SuperAdminDashboard() {
  const navigate = useNavigate();
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return 'dark';
    return safeStorage.get('superAdminTheme') || 'dark';
  });
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [plans, setPlans] = useState([]);
  const [topups, setTopups] = useState([]);
  const [historyEvents, setHistoryEvents] = useState([]);
  const [apiLogs, setApiLogs] = useState([]);
  const [isApiLogsLoading, setIsApiLogsLoading] = useState(false);
  const [apiLogsError, setApiLogsError] = useState('');
  const [apiLogRetentionDays, setApiLogRetentionDays] = useState(30);
  const [apiLogFilters, setApiLogFilters] = useState({
    level: 'all',
    projectId: 'all',
  });
  const [expandedApiLogRows, setExpandedApiLogRows] = useState({});
  const [connections, setConnections] = useState(null);
  const [connectionDrafts, setConnectionDrafts] = useState({});
  const [projectApiState, setProjectApiState] = useState(buildDefaultProjectApiState());
  const [projectApiPolicyDrafts, setProjectApiPolicyDrafts] = useState({});
  const [projectApiRuntimeDraft, setProjectApiRuntimeDraft] = useState(
    buildDefaultProjectApiState().runtimeSettings
  );
  const [projectApiKeyCache, setProjectApiKeyCache] = useState({});
  const [visibleApiKeys, setVisibleApiKeys] = useState({});
  const [copiedProjectApiId, setCopiedProjectApiId] = useState('');
  const [copiedProjectApiField, setCopiedProjectApiField] = useState('');
  const [projectApiAction, setProjectApiAction] = useState({
    creating: '',
    toggling: '',
    revealing: '',
    regenerating: '',
    copying: '',
    deletingProject: '',
    creatingProject: false,
    savingRuntime: false,
    savingPolicy: '',
  });
  const [manualProjectForm, setManualProjectForm] = useState(buildDefaultManualProjectForm());
  const [showSecret, setShowSecret] = useState({
    telegramToken: false,
    stripeSecret: false,
    stripeWebhook: false,
    openaiApi: false,
    geminiApi: false,
    smtpPass: false,
  });
  const [savingConnection, setSavingConnection] = useState('');
  const [planDrafts, setPlanDrafts] = useState({});
  const [savingPlanTier, setSavingPlanTier] = useState('');
  const [topupDrafts, setTopupDrafts] = useState([]);
  const [isSavingTopups, setIsSavingTopups] = useState(false);
  const [removingTopupKey, setRemovingTopupKey] = useState('');
  const [isTopupsLoading, setIsTopupsLoading] = useState(true);
  const [isPlansLoading, setIsPlansLoading] = useState(true);
  const [isConnectionsLoading, setIsConnectionsLoading] = useState(true);
  const [isProjectApisLoading, setIsProjectApisLoading] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(getInitialAdminTab);
  const [banner, setBanner] = useState({ type: '', text: '' });
  const [isCreateProjectModalOpen, setIsCreateProjectModalOpen] = useState(false);
  const [connectApiProjectId, setConnectApiProjectId] = useState('');
  const [connectApiLoadingKey, setConnectApiLoadingKey] = useState(false);
  const [connectApiLoadError, setConnectApiLoadError] = useState('');
  const [isUserModalOpen, setIsUserModalOpen] = useState(false);
  const [isSavingUser, setIsSavingUser] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [deletingUserId, setDeletingUserId] = useState('');
  const [deleteDialogUser, setDeleteDialogUser] = useState(null);
  const [deleteProjectDialog, setDeleteProjectDialog] = useState(null);
  const [userForm, setUserForm] = useState(buildDefaultForm());

  const authToken = safeStorage.get('authToken') || '';
  const isDark = theme === 'dark';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    safeStorage.set('superAdminTheme', theme);
  }, [theme]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    safeStorage.set(ADMIN_ACTIVE_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  const clearBanner = useCallback(() => setBanner({ type: '', text: '' }), []);

  const adminFetch = useCallback(
    async (path, options = {}) => {
      if (!authToken) {
        navigate('/login', { replace: true });
        throw new Error('Not authenticated');
      }
      const response = await fetch(apiUrl(path), {
        ...options,
        headers: {
          ...(options.headers || {}),
          Authorization: `Bearer ${authToken}`,
        },
      });
      const rawText = await response.text();
      let payload = {};
      try {
        payload = rawText ? JSON.parse(rawText) : {};
      } catch {
        payload = {};
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          safeStorage.remove('authToken');
          safeStorage.remove('username');
          safeStorage.remove('userId');
          safeStorage.remove('userRole');
          safeStorage.remove('isSuperAdmin');
          navigate('/login', { replace: true });
        }
        const statusText = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
        const rawSnippet = rawText
          ? rawText.replace(/\s+/g, ' ').trim().slice(0, 180)
          : '';
        throw new Error(payload?.error || payload?.details || rawSnippet || statusText || 'Request failed');
      }
      return payload;
    },
    [authToken, navigate]
  );

  const planNameMap = useMemo(() => {
    const map = {};
    for (const tier of PLAN_TIERS) {
      map[tier] = tier[0].toUpperCase() + tier.slice(1);
    }
    for (const plan of plans) {
      map[plan.tier] = plan.name || map[plan.tier];
    }
    return map;
  }, [plans]);

  const projectApiRows = useMemo(() => {
    const projects = Array.isArray(projectApiState.projects) ? projectApiState.projects : [];
    const apis = Array.isArray(projectApiState.apis) ? projectApiState.apis : [];
    const policies = Array.isArray(projectApiState.policies) ? projectApiState.policies : [];
    const apiByProjectId = new Map(apis.map((api) => [String(api.projectId || ''), api]));
    const policyByProjectId = new Map(
      policies.map((policy) => [String(policy.projectId || ''), normalizeProjectPipelinePolicy(policy)])
    );
    const rows = projects.map((project) => {
      const projectId = String(project.id || '');
      const api = apiByProjectId.get(projectId) || null;
      const policy = policyByProjectId.get(projectId) || normalizeProjectPipelinePolicy(null, projectId);
      return {
        projectId,
        projectName: String(project.name || api?.projectName || 'Untitled Project'),
        projectStatus: String(project.status || api?.projectStatus || 'active'),
        sourceType: String(project.sourceType || api?.sourceType || 'manual'),
        hasApi: Boolean(api),
        keyPrefix: String(api?.keyPrefix || 'adr_'),
        keyLast4: String(api?.keyLast4 || ''),
        keyPreview: String(api?.keyPreview || ''),
        isEnabled: api?.isEnabled === true,
        rotatedAt: api?.rotatedAt || null,
        lastUsedAt: api?.lastUsedAt || null,
        policy,
      };
    });

    const knownProjectIds = new Set(rows.map((row) => row.projectId));
    for (const api of apis) {
      const projectId = String(api.projectId || '');
      if (!projectId || knownProjectIds.has(projectId)) continue;
      rows.push({
        projectId,
        projectName: String(api.projectName || 'Untitled Project'),
        projectStatus: String(api.projectStatus || 'active'),
        sourceType: String(api.sourceType || 'manual'),
        hasApi: true,
        keyPrefix: String(api.keyPrefix || 'adr_'),
        keyLast4: String(api.keyLast4 || ''),
        keyPreview: String(api.keyPreview || ''),
        isEnabled: api.isEnabled === true,
        rotatedAt: api.rotatedAt || null,
        lastUsedAt: api.lastUsedAt || null,
        policy: policyByProjectId.get(projectId) || normalizeProjectPipelinePolicy(null, projectId),
      });
    }

    return rows;
  }, [projectApiState.projects, projectApiState.apis, projectApiState.policies]);

  const apiLogProjectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    for (const row of projectApiRows) {
      const projectId = String(row?.projectId || '').trim();
      if (!projectId || seen.has(projectId)) continue;
      seen.add(projectId);
      options.push({
        projectId,
        projectName: String(row?.projectName || 'Untitled Project'),
      });
    }
    return options;
  }, [projectApiRows]);

  const connectApiProjectRow = useMemo(() => {
    if (!connectApiProjectId) return null;
    return projectApiRows.find((row) => String(row?.projectId || '') === connectApiProjectId) || null;
  }, [projectApiRows, connectApiProjectId]);

  const connectApiGuide = useMemo(() => {
    if (!connectApiProjectRow) return null;
    const projectId = String(connectApiProjectRow.projectId || '').trim();
    if (!projectId) return null;
    const policy = normalizeProjectPipelinePolicy(
      projectApiPolicyDrafts?.[projectId] || connectApiProjectRow.policy || null,
      projectId
    );
    const generatePath = String(projectApiState.sharedEndpointPath || '/api/external/generate');
    const analyzePath = String(projectApiState.sharedAnalyzeEndpointPath || '/api/external/analyze');
    const generateUrl = String(projectApiState.sharedEndpointUrl || generatePath);
    const analyzeUrl = String(projectApiState.sharedAnalyzeEndpointUrl || analyzePath);
    const baseUrl = resolveApiDocsBaseUrl(generateUrl);
    const apiKey = String(projectApiKeyCache?.[projectId] || '').trim();
    const apiKeyPlaceholder = apiKey || 'YOUR_PROJECT_API_KEY';
    const sampleGenerateBodyNoReference = {
      productImage: 'data:image/png;base64,...',
      source: 'external_client',
      productName: 'Aurora Serum',
      mainIngredient: 'vitamin C + niacinamide',
      visualMood: 'clean, modern, elegant',
      dynamicElements: 'water splash, soft particles',
      colorPalette: 'pastel peach and white',
      backgroundStyle: 'glossy studio backdrop',
      brandName: 'Prachar',
      ctaText: 'Shop Now',
      aspectRatio: '1:1',
      lightingFocus: 'softbox',
      extraNotes: 'Hero-centered packshot with premium reflections',
      skipCaptionGeneration: true,
    };
    const sampleGenerateBodyWithReference = {
      productImage: 'data:image/png;base64,...',
      referenceImage: 'data:image/png;base64,...',
      source: 'external_client',
      productName: 'Aurora Serum',
      mainIngredient: 'vitamin C + niacinamide',
      visualMood: 'clean, modern, elegant',
      brandName: 'Prachar',
      ctaText: 'Shop Now',
      aspectRatio: '1:1',
      strictReferenceLock: true,
      skipCaptionGeneration: true,
    };
    const sampleAnalyzeBody = {
      productImage: 'data:image/png;base64,...',
      provider: 'gemini',
      pipelineName: policy.defaultAnalyzePipeline,
    };
    const generateCurlNoReference = [
      `curl -X POST "${baseUrl}${generatePath}"`,
      '  -H "Content-Type: application/json"',
      `  -H "x-project-api-key: ${apiKeyPlaceholder}"`,
      `  -d '${JSON.stringify(sampleGenerateBodyNoReference)}'`,
    ].join(' \\\n');
    const generateCurlWithReference = [
      `curl -X POST "${baseUrl}${generatePath}"`,
      '  -H "Content-Type: application/json"',
      `  -H "x-project-api-key: ${apiKeyPlaceholder}"`,
      `  -d '${JSON.stringify(sampleGenerateBodyWithReference)}'`,
    ].join(' \\\n');
    const analyzeCurl = [
      `curl -X POST "${baseUrl}${analyzePath}"`,
      '  -H "Content-Type: application/json"',
      `  -H "x-project-api-key: ${apiKeyPlaceholder}"`,
      `  -d '${JSON.stringify(sampleAnalyzeBody)}'`,
    ].join(' \\\n');
    const jsFetchGenerateExample = [
      `const API_BASE_URL = '${baseUrl}';`,
      `const PROJECT_API_KEY = '${apiKeyPlaceholder}';`,
      '',
      '// Case A: product image + structured prompt fields (no reference image)',
      `const payloadNoReference = ${toPrettyJson(sampleGenerateBodyNoReference)};`,
      '',
      `const responseNoReference = await fetch(\`${'${API_BASE_URL}'}${generatePath}\`, {`,
      "  method: 'POST',",
      '  headers: {',
      "    'Content-Type': 'application/json',",
      "    'x-project-api-key': PROJECT_API_KEY,",
      '  },',
      '  body: JSON.stringify(payloadNoReference),',
      '});',
      '',
      "const resultNoReference = await responseNoReference.json();",
      "console.log('No reference result:', resultNoReference);",
      '',
      '// Case B: product image + reference image',
      `const payloadWithReference = ${toPrettyJson(sampleGenerateBodyWithReference)};`,
      '',
      `const responseWithReference = await fetch(\`${'${API_BASE_URL}'}${generatePath}\`, {`,
      "  method: 'POST',",
      '  headers: {',
      "    'Content-Type': 'application/json',",
      "    'x-project-api-key': PROJECT_API_KEY,",
      '  },',
      '  body: JSON.stringify(payloadWithReference),',
      '});',
      '',
      "const resultWithReference = await responseWithReference.json();",
      "console.log('With reference result:', resultWithReference);",
    ].join('\n');
    const sampleGenerateResponse = {
      caption: 'Bold product caption',
      imageUrl: 'data:image/png;base64,...',
      generationVariant: 'reference_exact',
      pipelineName: 'gemini-edit-pipeline',
      effectivePipeline: 'gemini-edit-pipeline',
      schemaVersion: '2026-05-03',
    };
    const sampleAnalyzeResponse = {
      productName: 'Product Name',
      mainIngredient: 'Ingredient',
      visualMood: 'Clean, premium, modern',
      dynamicElements: 'water splash, soft particles',
      colorPalette: 'pastel peach and white',
      backgroundStyle: 'glossy studio backdrop',
      brandName: 'Prachar',
      ctaText: 'Shop Now',
      aspectRatio: '1:1',
      lightingFocus: 'softbox',
      extraNotes: '',
      confidence: {
        productName: 0.95,
        mainIngredient: 0.82,
        visualMood: 0.9,
      },
      suggestedGeneratePayload: {
        source: 'external_client',
        productName: 'Product Name',
        mainIngredient: 'Ingredient',
        visualMood: 'Clean, premium, modern',
        dynamicElements: 'water splash, soft particles',
        colorPalette: 'pastel peach and white',
        backgroundStyle: 'glossy studio backdrop',
        brandName: 'Prachar',
        ctaText: 'Shop Now',
        aspectRatio: '1:1',
        lightingFocus: 'softbox',
        extraNotes: '',
        skipCaptionGeneration: true,
      },
      analysisMeta: {
        provider: 'gemini',
        pipelineName: policy.defaultAnalyzePipeline,
        effectivePipeline: policy.defaultAnalyzePipeline,
      },
      schemaVersion: '2026-05-03',
    };
    const sampleValidationError = {
      code: 'INVALID_FIELD',
      message: 'Invalid aspectRatio value',
      field: 'aspectRatio',
      details: 'Allowed values: 1:1, 4:5, 16:9',
    };
    const jsFetchCombinedFlowExample = [
      `const API_BASE_URL = '${baseUrl}';`,
      `const PROJECT_API_KEY = '${apiKeyPlaceholder}';`,
      '',
      '// Step 1: Analyze (Fill with AI) from product image',
      "const productImage = 'data:image/png;base64,...';",
      `const analyzeResponse = await fetch(\`${'${API_BASE_URL}'}${analyzePath}\`, {`,
      "  method: 'POST',",
      '  headers: {',
      "    'Content-Type': 'application/json',",
      "    'x-project-api-key': PROJECT_API_KEY,",
      '  },',
      '  body: JSON.stringify({',
      '    productImage,',
      "    provider: 'gemini'",
      '  })',
      '});',
      'const analyzed = await analyzeResponse.json();',
      '',
      '// Step 2: Generate using analyzed fields + same product image',
      `const generateResponse = await fetch(\`${'${API_BASE_URL}'}${generatePath}\`, {`,
      "  method: 'POST',",
      '  headers: {',
      "    'Content-Type': 'application/json',",
      "    'x-project-api-key': PROJECT_API_KEY,",
      '  },',
      '  body: JSON.stringify({',
      '    productImage,',
      "    source: 'external_client',",
      '    productName: analyzed.productName,',
      '    mainIngredient: analyzed.mainIngredient,',
      '    visualMood: analyzed.visualMood,',
      '    aspectRatio: analyzed.aspectRatio || "1:1"',
      '  })',
      '});',
      'const generated = await generateResponse.json();',
      "console.log('Final image:', generated.imageUrl);",
    ].join('\n');
    const fullGuideText = [
      `ConnectAPI Integration Guide`,
      `Project: ${String(connectApiProjectRow.projectName || 'Untitled Project')}`,
      '',
      `Base URL: ${baseUrl}`,
      `Generate Endpoint: ${generatePath}`,
      `Analyze Endpoint: ${analyzePath}`,
      '',
      `Authentication Header: x-project-api-key`,
      `API Key: ${apiKey || 'YOUR_PROJECT_API_KEY'}`,
      '',
      `Generate Required Rule: prompt OR referenceImage must be provided`,
      `Generate Common Variables: productImage, referenceImage, logoImage, skipCaptionGeneration, strictReferenceLock, forceGeminiPlacementOnly, source`,
      `Generate Builder Fields (prompt can be auto-built): productName, mainIngredient, visualMood, dynamicElements, colorPalette, backgroundStyle, brandName, ctaText, aspectRatio, lightingFocus, extraNotes`,
      `Fixed pipeline behavior (no client pipelineName needed):`,
      `- productImage + prompt/fields -> gemini-edit-pipeline`,
      `- productImage + referenceImage -> reference-img-pipeline-1`,
      `Combined flow note: analyze + generate can be used together in sequence (mode is a UI choice, not an API limitation).`,
      '',
      `Analyze Required Rule: productImage OR referenceImage must be provided`,
      `Analyze Common Variables: productImage, referenceImage, provider (gemini|openai), pipelineName`,
      '',
      `Recommended Client Contract (Easy Mode)`,
      `1) Stable analyze keys: productName, mainIngredient, visualMood, dynamicElements, colorPalette, backgroundStyle, brandName, ctaText, aspectRatio, lightingFocus, extraNotes`,
      `2) Analyze should include suggestedGeneratePayload for direct generate call`,
      `3) Allowed enums: provider=[gemini|openai], aspectRatio=[1:1|4:5|16:9]`,
      `4) Validation error shape: { code, message, field, details }`,
      `5) Recommended field max lengths: productName(120), mainIngredient(120), visualMood(180), dynamicElements(240), colorPalette(160), backgroundStyle(180), brandName(120), ctaText(80), lightingFocus(80), extraNotes(500), prompt(1200)`,
      `6) Recommended image input limits: MIME=[image/png,image/jpeg,image/webp], maxFileSize=10MB, maxResolution=4096x4096`,
      `7) Suggested output policy: imageUrl is data URL or CDN URL (keep one policy fixed per environment)`,
      `8) Version contract: include schemaVersion in response for backward compatibility`,
      '',
      `Template: Fill with AI + Generate (2-step flow)`,
      `1) Call Analyze with productImage to get suggested fields`,
      `2) Call Generate with productImage + analyzed fields`,
      `3) Optional: add referenceImage in Generate for reference-guided output`,
      '',
      `Pipeline Policy`,
      `Generate default: ${policy.defaultGeneratePipeline}`,
      `Generate override: ${policy.allowGenerateOverride ? 'allowed' : 'blocked'}`,
      `Generate allowed: ${policy.allowedGeneratePipelines.join(', ') || '-'}`,
      `Analyze default: ${policy.defaultAnalyzePipeline}`,
      `Analyze override: ${policy.allowAnalyzeOverride ? 'allowed' : 'blocked'}`,
      `Analyze allowed: ${policy.allowedAnalyzePipelines.join(', ') || '-'}`,
      '',
      `Sample Request Body (Generate - No Reference)`,
      toPrettyJson(sampleGenerateBodyNoReference),
      '',
      `Sample Request Body (Generate - With Reference)`,
      toPrettyJson(sampleGenerateBodyWithReference),
      '',
      `Sample Request Body (Analyze)`,
      toPrettyJson(sampleAnalyzeBody),
      '',
      `Sample cURL (Generate - No Reference)`,
      generateCurlNoReference,
      '',
      `Sample cURL (Generate - With Reference)`,
      generateCurlWithReference,
      '',
      `Sample cURL (Analyze)`,
      analyzeCurl,
      '',
      `Sample JS Fetch (Generate - 2 Cases)`,
      jsFetchGenerateExample,
      '',
      `Sample JS Fetch (Analyze + Generate Combined Flow)`,
      jsFetchCombinedFlowExample,
      '',
      `Sample Response (Generate)`,
      toPrettyJson(sampleGenerateResponse),
      '',
      `Sample Response (Analyze)`,
      toPrettyJson(sampleAnalyzeResponse),
      '',
      `Sample Validation Error`,
      toPrettyJson(sampleValidationError),
    ].join('\n');

    return {
      projectId,
      projectName: String(connectApiProjectRow.projectName || 'Untitled Project'),
      hasApi: connectApiProjectRow.hasApi === true,
      baseUrl,
      generatePath,
      analyzePath,
      generateUrl,
      analyzeUrl,
      apiKey,
      policy,
      generateCurlNoReference,
      generateCurlWithReference,
      analyzeCurl,
      jsFetchGenerateExample,
      jsFetchCombinedFlowExample,
      sampleGenerateResponse,
      sampleAnalyzeResponse,
      sampleValidationError,
      sampleGenerateBodyNoReference,
      sampleGenerateBodyWithReference,
      sampleAnalyzeBody,
      fullGuideText,
    };
  }, [connectApiProjectRow, connectApiProjectId, projectApiPolicyDrafts, projectApiState, projectApiKeyCache]);

  const getPlanCredits = useCallback(
    (tier) => {
      const matched = plans.find((plan) => plan.tier === tier);
      if (matched) return Number(matched.monthlyCredits || 0);
      return PLAN_DEFAULT_CREDITS[tier] ?? PLAN_DEFAULT_CREDITS.free;
    },
    [plans]
  );

  const applyProjectApiPayload = useCallback((payload) => {
    const projects = Array.isArray(payload?.projects)
      ? payload.projects
          .map((item) => ({
            id: String(item?.id || ''),
            name: String(item?.name || ''),
            status: String(item?.status || ''),
            ownerUserId: item?.ownerUserId ? String(item.ownerUserId) : '',
            createdAt: item?.createdAt || null,
            updatedAt: item?.updatedAt || null,
            sourceType: String(item?.sourceType || 'manual'),
            telegramId: item?.telegramId ? String(item.telegramId) : '',
            telegramBotUsername: item?.telegramBotUsername ? String(item.telegramBotUsername) : '',
          }))
          .filter((item) => item.id)
          .filter((item) => shouldShowProjectInApiSection(item))
      : [];

    const apis = Array.isArray(payload?.apis)
      ? payload.apis
          .map((item) => ({
            projectId: String(item?.projectId || ''),
            projectName: String(item?.projectName || ''),
            projectStatus: String(item?.projectStatus || ''),
            ownerUserId: item?.ownerUserId ? String(item.ownerUserId) : '',
            keyPrefix: String(item?.keyPrefix || ''),
            keyLast4: String(item?.keyLast4 || ''),
            keyPreview: String(item?.keyPreview || ''),
            isEnabled: item?.isEnabled !== false,
            createdByUserId: item?.createdByUserId ? String(item.createdByUserId) : '',
            rotatedAt: item?.rotatedAt || null,
            lastUsedAt: item?.lastUsedAt || null,
            createdAt: item?.createdAt || null,
            updatedAt: item?.updatedAt || null,
            sourceType: String(item?.sourceType || 'manual'),
            telegramId: item?.telegramId ? String(item.telegramId) : '',
            telegramBotUsername: item?.telegramBotUsername ? String(item.telegramBotUsername) : '',
          }))
          .filter((item) => item.projectId)
          .filter((item) => shouldShowProjectInApiSection(item))
      : [];

    const policies = Array.isArray(payload?.policies)
      ? payload.policies
          .map((item) => normalizeProjectPipelinePolicy(item))
          .filter((item) => item.projectId)
      : [];

    const runtimeSettings = normalizeRuntimeSettings(payload?.runtimeSettings || {});

    const sharedEndpointPath = String(payload?.sharedEndpointPath || '/api/external/generate');
    const sharedEndpointUrl = String(payload?.sharedEndpointUrl || sharedEndpointPath);
    const sharedAnalyzeEndpointPath = String(payload?.sharedAnalyzeEndpointPath || '/api/external/analyze');
    const sharedAnalyzeEndpointUrl = String(payload?.sharedAnalyzeEndpointUrl || sharedAnalyzeEndpointPath);
    const pipelineCatalog = {
      generate: sanitizePipelineList(payload?.pipelineCatalog?.generate, GENERATE_PIPELINE_OPTIONS)
        .filter((item) => GENERATE_PIPELINE_OPTIONS.includes(item)),
      analyze: sanitizePipelineList(payload?.pipelineCatalog?.analyze, ANALYZE_PIPELINE_OPTIONS)
        .filter((item) => ANALYZE_PIPELINE_OPTIONS.includes(item)),
    };

    setProjectApiState({
      projects,
      apis,
      policies,
      runtimeSettings,
      sharedEndpointPath,
      sharedEndpointUrl,
      sharedAnalyzeEndpointPath,
      sharedAnalyzeEndpointUrl,
      pipelineCatalog: {
        generate: pipelineCatalog.generate.length ? pipelineCatalog.generate : [...GENERATE_PIPELINE_OPTIONS],
        analyze: pipelineCatalog.analyze.length ? pipelineCatalog.analyze : [...ANALYZE_PIPELINE_OPTIONS],
      },
    });
    setProjectApiRuntimeDraft(runtimeSettings);
    setProjectApiPolicyDrafts(() => {
      const draftByProjectId = {};
      const policyByProjectId = new Map(policies.map((policy) => [policy.projectId, policy]));
      for (const project of projects) {
        const projectId = String(project.id || '');
        if (!projectId) continue;
        draftByProjectId[projectId] = normalizeProjectPipelinePolicy(
          policyByProjectId.get(projectId) || null,
          projectId
        );
      }
      for (const api of apis) {
        const projectId = String(api.projectId || '');
        if (!projectId || draftByProjectId[projectId]) continue;
        draftByProjectId[projectId] = normalizeProjectPipelinePolicy(
          policyByProjectId.get(projectId) || null,
          projectId
        );
      }
      return draftByProjectId;
    });

    setProjectApiKeyCache((prev) => {
      const allowedProjectIds = new Set(apis.map((item) => item.projectId));
      const next = {};
      for (const [projectId, key] of Object.entries(prev || {})) {
        if (allowedProjectIds.has(projectId) && key) {
          next[projectId] = key;
        }
      }
      return next;
    });
    setVisibleApiKeys((prev) => {
      const allowedProjectIds = new Set(apis.map((item) => item.projectId));
      const next = {};
      for (const [projectId, isVisible] of Object.entries(prev || {})) {
        if (allowedProjectIds.has(projectId) && isVisible === true) {
          next[projectId] = true;
        }
      }
      return next;
    });
  }, []);

  const upsertProjectApiRow = useCallback((nextRow) => {
    if (!nextRow?.projectId) return;
    setProjectApiState((prev) => {
      const remaining = (prev.apis || []).filter((row) => row.projectId !== nextRow.projectId);
      return {
        ...prev,
        apis: [nextRow, ...remaining],
      };
    });
  }, []);

  const ensureProjectApiKeyLoaded = useCallback(
    async (projectId) => {
      const normalizedProjectId = String(projectId || '').trim();
      if (!normalizedProjectId) throw new Error('Invalid project id');

      const cached = String(projectApiKeyCache?.[normalizedProjectId] || '').trim();
      if (cached) return cached;

      const response = await adminFetch(`/api/admin/project-apis/${normalizedProjectId}/key`);
      const apiKey = String(response?.apiKey || '').trim();
      if (!apiKey) {
        throw new Error('Could not load API key.');
      }
      setProjectApiKeyCache((prev) => ({ ...prev, [normalizedProjectId]: apiKey }));
      return apiKey;
    },
    [adminFetch, projectApiKeyCache]
  );

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setIsTopupsLoading(true);
    setIsPlansLoading(true);
    setIsConnectionsLoading(true);
    setIsProjectApisLoading(true);
    const projectApisTask = adminFetch('/api/admin/project-apis')
      .then((payload) => {
        applyProjectApiPayload(payload || {});
      })
      .catch(() => {
        applyProjectApiPayload(buildDefaultProjectApiState());
      })
      .finally(() => {
        setIsProjectApisLoading(false);
      });
    try {
      const [statsRes, usersRes, plansRes, topupsRes, connectionsRes, historyRes] = await Promise.allSettled([
        adminFetch('/api/admin/stats'),
        adminFetch('/api/admin/users'),
        adminFetch('/api/admin/plans'),
        adminFetch('/api/admin/topups'),
        adminFetch('/api/admin/connections'),
        adminFetch('/api/admin/history'),
      ]);

      if (statsRes.status === 'fulfilled') {
        setStats(statsRes.value || null);
      } else {
        setStats(null);
      }

      if (usersRes.status === 'fulfilled') {
        setUsers(Array.isArray(usersRes.value?.users) ? usersRes.value.users : []);
      } else {
        setUsers([]);
      }

      const fetchedPlans =
        plansRes.status === 'fulfilled' && Array.isArray(plansRes.value?.plans)
          ? plansRes.value.plans
          : [];
      setPlans(fetchedPlans);
      setPlanDrafts(
        fetchedPlans.reduce((acc, plan) => {
          acc[plan.tier] = {
            name: String(plan.name || ''),
            priceUsdMonthly: String(plan.priceUsdMonthly ?? ''),
            monthlyCredits: String(plan.monthlyCredits ?? ''),
          };
          return acc;
        }, {})
      );
      setIsPlansLoading(false);

      const fetchedTopups =
        topupsRes.status === 'fulfilled' && Array.isArray(topupsRes.value?.topups)
          ? topupsRes.value.topups
          : [];
      setTopups(fetchedTopups);
      setTopupDrafts(normalizeTopupDraftRows(fetchedTopups));

      const defaultConnections = buildDefaultConnections();
      if (connectionsRes.status === 'fulfilled' && Array.isArray(connectionsRes.value?.connections)) {
        const nextConnections = { ...defaultConnections };
        for (const item of connectionsRes.value.connections) {
          const provider = String(item?.provider || '').toLowerCase();
          if (!nextConnections[provider]) continue;
          nextConnections[provider] = {
            ...nextConnections[provider],
            isEnabled: item?.isEnabled === true,
            config: {
              ...nextConnections[provider].config,
              ...(item?.config && typeof item.config === 'object' ? item.config : {}),
            },
          };
        }
        setConnections(nextConnections);
        setConnectionDrafts(nextConnections);
      } else {
        setConnections(defaultConnections);
        setConnectionDrafts(defaultConnections);
      }
      setIsConnectionsLoading(false);

      if (historyRes.status === 'fulfilled' && Array.isArray(historyRes.value?.history)) {
        setHistoryEvents(historyRes.value.history);
      } else {
        setHistoryEvents([]);
      }

      const errors = [];
      if (statsRes.status === 'rejected') errors.push('stats');
      if (usersRes.status === 'rejected') errors.push('users');
      if (plansRes.status === 'rejected') errors.push('plans');
      if (topupsRes.status === 'rejected') errors.push('topups');
      if (connectionsRes.status === 'rejected') errors.push('connections');
      if (historyRes.status === 'rejected') errors.push('history');
      if (errors.length > 0) {
        setBanner({ type: 'error', text: `Some data failed to load: ${errors.join(', ')}` });
      } else {
        clearBanner();
      }
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to load admin data' });
      setTopups([]);
      setTopupDrafts([]);
      setPlans([]);
      setPlanDrafts({});
      const defaultConnections = buildDefaultConnections();
      setConnections(defaultConnections);
      setConnectionDrafts(defaultConnections);
      applyProjectApiPayload(buildDefaultProjectApiState());
    } finally {
      setIsTopupsLoading(false);
      setIsPlansLoading(false);
      setIsConnectionsLoading(false);
      setIsLoading(false);
      await projectApisTask;
    }
  }, [adminFetch, clearBanner, applyProjectApiPayload]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const fetchApiLogs = useCallback(
    async ({ showSpinner = true } = {}) => {
      if (showSpinner) setIsApiLogsLoading(true);
      setApiLogsError('');
      try {
        const params = new URLSearchParams();
        params.set('limit', '100');
        if (apiLogFilters.level && apiLogFilters.level !== 'all') {
          params.set('level', apiLogFilters.level);
        }
        if (apiLogFilters.projectId && apiLogFilters.projectId !== 'all') {
          params.set('projectId', apiLogFilters.projectId);
        }
        const response = await adminFetch(`/api/admin/api-logs?${params.toString()}`);
        setApiLogs(Array.isArray(response?.logs) ? response.logs : []);
        const retentionDays = Number(response?.retentionDays);
        setApiLogRetentionDays(Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 30);
      } catch (error) {
        setApiLogs([]);
        setApiLogsError(error?.message || 'Failed to load API logs.');
      } finally {
        if (showSpinner) setIsApiLogsLoading(false);
      }
    },
    [adminFetch, apiLogFilters.level, apiLogFilters.projectId]
  );

  useEffect(() => {
    if (activeTab !== 'API Log') return;
    fetchApiLogs();
  }, [activeTab, fetchApiLogs]);

  useEffect(() => {
    setExpandedApiLogRows({});
  }, [apiLogs]);

  const handleLogout = () => {
    safeStorage.remove('authToken');
    safeStorage.remove('username');
    safeStorage.remove('userId');
    safeStorage.remove('userRole');
    safeStorage.remove('isSuperAdmin');
    if (DEV_AUTH_BYPASS_ENABLED) {
      safeStorage.set(DEV_AUTH_BYPASS_LOGOUT_FLAG_KEY, 'true');
    }
    navigate('/login', { replace: true });
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const openAddModal = () => {
    clearBanner();
    setEditingUser(null);
    setUserForm(buildDefaultForm());
    setIsUserModalOpen(true);
  };

  const openCreateProjectModal = () => {
    clearBanner();
    setIsCreateProjectModalOpen(true);
  };

  const closeCreateProjectModal = () => {
    setIsCreateProjectModalOpen(false);
    setManualProjectForm(buildDefaultManualProjectForm());
  };

  const openEditModal = (user) => {
    clearBanner();
    setEditingUser(user);
    setUserForm({
      username: user?.username || '',
      email: user?.email || '',
      password: '',
      role: user?.role || 'member',
      planTier: user?.plan_tier || 'free',
      credits: String(user?.credits ?? getPlanCredits(user?.plan_tier || 'free')),
      isActive: user?.is_active !== false,
    });
    setIsUserModalOpen(true);
  };

  const closeUserModal = () => {
    setIsUserModalOpen(false);
    setEditingUser(null);
    setUserForm(buildDefaultForm());
  };

  const handleFormChange = (field, value) => {
    setUserForm((prev) => {
      if (field === 'planTier') {
        const planCredits = getPlanCredits(value);
        return {
          ...prev,
          planTier: value,
          credits: String(planCredits),
        };
      }
      return { ...prev, [field]: value };
    });
  };

  const handleSaveUser = async () => {
    clearBanner();
    const username = String(userForm.username || '').trim();
    const email = String(userForm.email || '').trim();
    const password = String(userForm.password || '');
    const credits = Number(userForm.credits);

    if (!username || username.length < 2) {
      setBanner({ type: 'error', text: 'Username must be at least 2 characters.' });
      return;
    }
    if (!editingUser && password.length < 6) {
      setBanner({ type: 'error', text: 'Password must be at least 6 characters.' });
      return;
    }
    if (editingUser && password && password.length < 6) {
      setBanner({ type: 'error', text: 'New password must be at least 6 characters.' });
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setBanner({ type: 'error', text: 'Please enter a valid email address.' });
      return;
    }
    if (!Number.isFinite(credits) || credits < 0) {
      setBanner({ type: 'error', text: 'Credits must be a non-negative number.' });
      return;
    }

    setIsSavingUser(true);
    try {
      const payload = {
        username,
        email,
        role: userForm.role,
        planTier: userForm.planTier,
        credits: Math.floor(credits),
        isActive: Boolean(userForm.isActive),
      };
      if (password) payload.password = password;

      if (editingUser?.id) {
        await adminFetch(`/api/admin/users/${editingUser.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setBanner({ type: 'success', text: 'User updated successfully.' });
      } else {
        await adminFetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        setBanner({ type: 'success', text: 'New user created successfully.' });
      }

      closeUserModal();
      await fetchData();
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to save user.' });
    } finally {
      setIsSavingUser(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (!user?.id) return;
    clearBanner();
    setDeleteDialogUser(user);
  };

  const closeDeleteDialog = () => {
    if (deletingUserId) return;
    setDeleteDialogUser(null);
  };

  const confirmDeleteUser = async () => {
    if (!deleteDialogUser?.id) return;

    const targetUser = deleteDialogUser;
    setDeletingUserId(targetUser.id);
    try {
      await adminFetch(`/api/admin/users/${targetUser.id}`, { method: 'DELETE' });
      setBanner({ type: 'success', text: `${targetUser.username} has been permanently deleted.` });
      setDeleteDialogUser(null);
      await fetchData();
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to delete user.' });
    } finally {
      setDeletingUserId('');
    }
  };

  const handlePlanDraftChange = (tier, field, value) => {
    setPlanDrafts((prev) => ({
      ...prev,
      [tier]: {
        ...(prev[tier] || {}),
        [field]: value,
      },
    }));
  };

  const handleSavePlan = async (tier, overrideDraft = null) => {
    clearBanner();
    const draft = overrideDraft || planDrafts[tier] || {};
    const name = String(draft.name || '').trim();
    const price = Number(draft.priceUsdMonthly);
    const credits = Number(draft.monthlyCredits);

    if (!name || name.length < 2) {
      setBanner({ type: 'error', text: `Plan name for ${tier} must be at least 2 characters.` });
      return;
    }
    if (!Number.isFinite(price) || price < 0) {
      setBanner({ type: 'error', text: `Price for ${tier} must be a non-negative number.` });
      return;
    }
    if (!Number.isFinite(credits) || credits < 0) {
      setBanner({ type: 'error', text: `Monthly credits for ${tier} must be a non-negative number.` });
      return;
    }

    setSavingPlanTier(tier);
    try {
      await adminFetch(`/api/admin/plans/${tier}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          priceUsdMonthly: Number(price.toFixed(2)),
          monthlyCredits: Math.floor(credits),
        }),
      });
      setBanner({ type: 'success', text: `${name} plan updated.` });
      await fetchData();
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to update plan.' });
    } finally {
      setSavingPlanTier('');
    }
  };

  const handleResetPlan = async (tier) => {
    clearBanner();
    const defaultName = PLAN_DEFAULT_NAMES[tier] || tier.toUpperCase();
    const defaultPrice = PLAN_DEFAULT_PRICES[tier] ?? 0;
    const defaultCredits = PLAN_DEFAULT_CREDITS[tier] ?? 0;

    const confirmed = window.confirm(`Reset ${defaultName} plan to default values?`);
    if (!confirmed) return;

    setSavingPlanTier(tier);
    try {
      await adminFetch(`/api/admin/plans/${tier}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: defaultName,
          priceUsdMonthly: defaultPrice,
          monthlyCredits: defaultCredits,
        }),
      });
      setBanner({ type: 'success', text: `${defaultName} plan reset to defaults.` });
      await fetchData();
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to reset plan.' });
    } finally {
      setSavingPlanTier('');
    }
  };

  const handleQuickEditPlan = async (plan) => {
    const tier = String(plan?.tier || '').toLowerCase();
    if (!tier) return;
    const current = planDrafts[tier] || {
      name: plan.name || PLAN_DEFAULT_NAMES[tier] || tier.toUpperCase(),
      priceUsdMonthly: String(plan.priceUsdMonthly ?? PLAN_DEFAULT_PRICES[tier] ?? 0),
      monthlyCredits: String(plan.monthlyCredits ?? PLAN_DEFAULT_CREDITS[tier] ?? 0),
    };

    const nextName = window.prompt('Plan name', current.name);
    if (nextName === null) return;
    const nextPrice = window.prompt('Price (USD/month)', String(current.priceUsdMonthly));
    if (nextPrice === null) return;
    const nextCredits = window.prompt('Monthly credits', String(current.monthlyCredits));
    if (nextCredits === null) return;

    const draft = {
      name: String(nextName || '').trim(),
      priceUsdMonthly: String(nextPrice || '').trim(),
      monthlyCredits: String(nextCredits || '').trim(),
    };
    setPlanDrafts((prev) => ({ ...prev, [tier]: draft }));
    await handleSavePlan(tier, draft);
  };

  const handleTopupDraftChange = (index, field, value) => {
    setTopupDrafts((prev) =>
      prev.map((item, rowIndex) =>
        rowIndex === index
          ? {
            ...item,
            [field]: field === 'isActive' ? value === true : value,
          }
          : item
      )
    );
  };

  const handleAddTopupDraft = () => {
    setTopupDrafts((prev) => [
      ...prev,
      {
        credits: '',
        priceUsd: '',
        isActive: true,
        sortOrder: prev.length + 1,
      },
    ]);
  };

  const handleRemoveTopupDraft = async (index) => {
    clearBanner();
    const currentRows = topupDrafts;
    const target = currentRows[index];
    if (!target) return;
    if (currentRows.length <= 1) {
      setBanner({ type: 'error', text: 'At least one top-up package is required.' });
      return;
    }

    const credits = Math.floor(Number(target.credits));
    const rowKey = `${Number.isFinite(credits) ? credits : 'new'}-${index}`;
    if (!Number.isFinite(credits) || credits <= 0) {
      setTopupDrafts((prev) => prev.filter((_, rowIndex) => rowIndex !== index));
      return;
    }

    setRemovingTopupKey(rowKey);
    try {
      const response = await adminFetch(`/api/admin/topups/${credits}`, { method: 'DELETE' });
      const savedTopups = Array.isArray(response?.topups) ? response.topups : [];
      setTopups(savedTopups);
      setTopupDrafts(normalizeTopupDraftRows(savedTopups));
      setBanner({ type: 'success', text: `${credits} credits package removed.` });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to remove top-up package.' });
    } finally {
      setRemovingTopupKey('');
    }
  };

  const handleSaveTopups = async () => {
    clearBanner();
    if (!topupDrafts.length) {
      setBanner({ type: 'error', text: 'At least one top-up package is required.' });
      return;
    }

    const normalized = topupDrafts.map((item, index) => ({
      credits: Math.floor(Number(item?.credits)),
      priceUsd: Number(item?.priceUsd),
      isActive: item?.isActive !== false,
      sortOrder: index + 1,
    }));

    const seenCredits = new Set();
    let hasActive = false;
    for (const item of normalized) {
      if (!Number.isFinite(item.credits) || item.credits <= 0) {
        setBanner({ type: 'error', text: 'Each credits value must be a positive number.' });
        return;
      }
      if (!Number.isFinite(item.priceUsd) || item.priceUsd < 0) {
        setBanner({ type: 'error', text: 'Each price must be a non-negative number.' });
        return;
      }
      if (seenCredits.has(item.credits)) {
        setBanner({ type: 'error', text: `Duplicate credits found: ${item.credits}` });
        return;
      }
      seenCredits.add(item.credits);
      if (item.isActive) hasActive = true;
    }

    if (!hasActive) {
      setBanner({ type: 'error', text: 'At least one package must remain active.' });
      return;
    }

    setIsSavingTopups(true);
    try {
      const response = await adminFetch('/api/admin/topups', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topups: normalized.map((item) => ({
            credits: item.credits,
            priceUsd: Number(item.priceUsd.toFixed(2)),
            isActive: item.isActive,
            sortOrder: item.sortOrder,
          })),
        }),
      });
      const savedTopups = Array.isArray(response?.topups) ? response.topups : normalized;
      setTopups(savedTopups);
      setTopupDrafts(normalizeTopupDraftRows(savedTopups));
      setBanner({ type: 'success', text: 'Top-up packages updated.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to update top-up packages.' });
    } finally {
      setIsSavingTopups(false);
    }
  };

  const handleResetTopups = () => {
    const confirmed = window.confirm('Reset top-up packages to default values?');
    if (!confirmed) return;
    setTopupDrafts(normalizeTopupDraftRows(buildFallbackTopups()));
  };

  const handleConnectionToggle = (provider) => {
    setConnectionDrafts((prev) => {
      const current = prev[provider] || buildDefaultConnections()[provider];
      return {
        ...prev,
        [provider]: {
          ...current,
          isEnabled: !current.isEnabled,
        },
      };
    });
  };

  const handleConnectionField = (provider, field, value) => {
    setConnectionDrafts((prev) => {
      const current = prev[provider] || buildDefaultConnections()[provider];
      return {
        ...prev,
        [provider]: {
          ...current,
          config: {
            ...(current.config || {}),
            [field]: value,
          },
        },
      };
    });
  };

  const handleSaveConnection = async (provider) => {
    const draft = connectionDrafts[provider];
    if (!draft) return;

    setSavingConnection(provider);
    clearBanner();
    try {
      const response = await adminFetch(`/api/admin/connections/${provider}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isEnabled: Boolean(draft.isEnabled),
          config: draft.config || {},
        }),
      });

      const savedConnection = response?.connection;
      if (savedConnection?.provider) {
        setConnections((prev) => ({
          ...prev,
          [savedConnection.provider]: savedConnection,
        }));
        setConnectionDrafts((prev) => ({
          ...prev,
          [savedConnection.provider]: savedConnection,
        }));
      }

      setBanner({
        type: 'success',
        text: response?.note || `${provider} settings saved.`,
      });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || `Failed to save ${provider} settings.` });
    } finally {
      setSavingConnection('');
    }
  };

  const handleGenerateProjectApi = async (projectIdInput) => {
    clearBanner();
    const projectId = String(projectIdInput || '').trim();
    if (!projectId) {
      setBanner({ type: 'error', text: 'Please select a valid project first.' });
      return;
    }

    setProjectApiAction((prev) => ({ ...prev, creating: projectId }));
    try {
      const response = await adminFetch('/api/admin/project-apis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (response?.api) {
        upsertProjectApiRow(response.api);
      }
      if (response?.api?.projectId && response?.apiKey) {
        setProjectApiKeyCache((prev) => ({
          ...prev,
          [response.api.projectId]: String(response.apiKey),
        }));
        setVisibleApiKeys((prev) => ({
          ...prev,
          [response.api.projectId]: false,
        }));
      }
      if (response?.sharedEndpointPath || response?.sharedEndpointUrl) {
        setProjectApiState((prev) => ({
          ...prev,
          sharedEndpointPath: String(response.sharedEndpointPath || prev.sharedEndpointPath),
          sharedEndpointUrl: String(response.sharedEndpointUrl || prev.sharedEndpointUrl),
          sharedAnalyzeEndpointPath: String(response.sharedAnalyzeEndpointPath || prev.sharedAnalyzeEndpointPath),
          sharedAnalyzeEndpointUrl: String(response.sharedAnalyzeEndpointUrl || prev.sharedAnalyzeEndpointUrl),
        }));
      }
      setBanner({ type: 'success', text: 'Project API key generated successfully.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to generate project API key.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, creating: '' }));
    }
  };

  const handleCreateProject = async () => {
    clearBanner();
    const name = String(manualProjectForm.name || '').trim();
    const description = String(manualProjectForm.description || '').trim();

    if (!name || name.length < 2) {
      setBanner({ type: 'error', text: 'Project name must be at least 2 characters.' });
      return;
    }

    setProjectApiAction((prev) => ({ ...prev, creatingProject: true }));
    try {
      const response = await adminFetch('/api/admin/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description }),
      });
      const createdProject = response?.project;
      if (!createdProject?.id) {
        throw new Error('Project creation failed.');
      }

      setProjectApiState((prev) => ({
        ...prev,
        projects: [createdProject, ...(prev.projects || []).filter((item) => String(item.id) !== String(createdProject.id))],
        policies: [
          normalizeProjectPipelinePolicy(null, createdProject.id),
          ...(prev.policies || []).filter((item) => String(item.projectId) !== String(createdProject.id)),
        ],
      }));
      setProjectApiPolicyDrafts((prev) => ({
        ...prev,
        [String(createdProject.id)]: normalizeProjectPipelinePolicy(null, createdProject.id),
      }));
      setManualProjectForm(buildDefaultManualProjectForm());
      setIsCreateProjectModalOpen(false);
      setBanner({ type: 'success', text: 'Project created successfully.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to create project.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, creatingProject: false }));
    }
  };

  const handleDeleteProject = (projectId, projectName) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return;
    clearBanner();
    setDeleteProjectDialog({
      id: normalizedProjectId,
      name: String(projectName || 'Untitled Project'),
    });
  };

  const closeProjectDeleteDialog = () => {
    if (projectApiAction.deletingProject) return;
    setDeleteProjectDialog(null);
  };

  const confirmDeleteProject = async () => {
    const normalizedProjectId = String(deleteProjectDialog?.id || '').trim();
    if (!normalizedProjectId) return;

    setProjectApiAction((prev) => ({ ...prev, deletingProject: normalizedProjectId }));
    try {
      await adminFetch(`/api/admin/projects/${normalizedProjectId}`, { method: 'DELETE' });
      setProjectApiState((prev) => ({
        ...prev,
        projects: (prev.projects || []).filter((item) => String(item.id) !== normalizedProjectId),
        apis: (prev.apis || []).filter((item) => String(item.projectId) !== normalizedProjectId),
        policies: (prev.policies || []).filter((item) => String(item.projectId) !== normalizedProjectId),
      }));
      setProjectApiKeyCache((prev) => {
        const next = { ...(prev || {}) };
        delete next[normalizedProjectId];
        return next;
      });
      setVisibleApiKeys((prev) => {
        const next = { ...(prev || {}) };
        delete next[normalizedProjectId];
        return next;
      });
      setCopiedProjectApiId((prev) => (prev === normalizedProjectId ? '' : prev));
      setProjectApiPolicyDrafts((prev) => {
        const next = { ...(prev || {}) };
        delete next[normalizedProjectId];
        return next;
      });
      setDeleteProjectDialog(null);
      setBanner({ type: 'success', text: 'Project deleted successfully.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to delete project.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, deletingProject: '' }));
    }
  };

  const handleToggleProjectApi = async (projectId, nextEnabled) => {
    if (!projectId) return;
    clearBanner();
    setProjectApiAction((prev) => ({ ...prev, toggling: projectId }));
    try {
      const response = await adminFetch(`/api/admin/project-apis/${projectId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isEnabled: Boolean(nextEnabled) }),
      });
      if (response?.api) {
        upsertProjectApiRow(response.api);
      }
      setBanner({
        type: 'success',
        text: `Project API ${nextEnabled ? 'enabled' : 'disabled'} successfully.`,
      });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to update project API status.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, toggling: '' }));
    }
  };

  const handleProjectApiRuntimeDraftToggle = (field) => {
    setProjectApiRuntimeDraft((prev) => ({
      ...prev,
      [field]: prev?.[field] !== false ? false : true,
    }));
  };

  const handleSaveProjectApiRuntime = async () => {
    clearBanner();
    setProjectApiAction((prev) => ({ ...prev, savingRuntime: true }));
    try {
      const response = await adminFetch('/api/admin/project-apis/runtime-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          externalGenerateEnabled: projectApiRuntimeDraft?.externalGenerateEnabled !== false,
          externalAnalyzeEnabled: projectApiRuntimeDraft?.externalAnalyzeEnabled !== false,
        }),
      });
      const runtimeSettings = normalizeRuntimeSettings(response?.runtimeSettings || {});
      setProjectApiState((prev) => ({
        ...prev,
        runtimeSettings,
      }));
      setProjectApiRuntimeDraft(runtimeSettings);
      setBanner({ type: 'success', text: 'External runtime settings saved.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to save runtime settings.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, savingRuntime: false }));
    }
  };

  const handleProjectPolicyField = (projectId, field, value) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return;
    setProjectApiPolicyDrafts((prev) => {
      const existing = normalizeProjectPipelinePolicy(prev?.[normalizedProjectId] || null, normalizedProjectId);
      let next = {
        ...existing,
        [field]: value,
      };
      return {
        ...prev,
        [normalizedProjectId]: next,
      };
    });
  };

  const handleProjectPolicyToggleAllowed = (projectId, endpointType, pipelineName) => {
    const normalizedProjectId = String(projectId || '').trim();
    const token = String(pipelineName || '').trim().toLowerCase();
    if (!normalizedProjectId || !token) return;
    setProjectApiPolicyDrafts((prev) => {
      const existing = normalizeProjectPipelinePolicy(prev?.[normalizedProjectId] || null, normalizedProjectId);
      const isGenerate = endpointType === 'generate';
      const allowedField = isGenerate ? 'allowedGeneratePipelines' : 'allowedAnalyzePipelines';
      const defaultField = isGenerate ? 'defaultGeneratePipeline' : 'defaultAnalyzePipeline';
      const allowedUniverse = isGenerate ? GENERATE_PIPELINE_OPTIONS : ANALYZE_PIPELINE_OPTIONS;
      const currentAllowed = Array.isArray(existing[allowedField]) ? existing[allowedField] : [];
      const currentlyIncluded = currentAllowed.includes(token);
      let nextAllowed = currentlyIncluded
        ? currentAllowed.filter((item) => item !== token)
        : [...currentAllowed, token];
      nextAllowed = nextAllowed.filter((item) => allowedUniverse.includes(item));
      return {
        ...prev,
        [normalizedProjectId]: {
          ...existing,
          [allowedField]: nextAllowed,
          [defaultField]: normalizePipelineFallback(existing[defaultField], allowedUniverse[0], allowedUniverse),
        },
      };
    });
  };

  const handleSaveProjectApiPolicy = async (projectId) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return;
    const draft = normalizeProjectPipelinePolicy(
      projectApiPolicyDrafts?.[normalizedProjectId] || null,
      normalizedProjectId
    );
    clearBanner();
    setProjectApiAction((prev) => ({ ...prev, savingPolicy: normalizedProjectId }));
    try {
      const response = await adminFetch(`/api/admin/project-apis/${normalizedProjectId}/pipeline-policy`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defaultGeneratePipeline: draft.defaultGeneratePipeline,
          allowedGeneratePipelines: draft.allowedGeneratePipelines,
          allowGenerateOverride: draft.allowGenerateOverride !== false,
          defaultAnalyzePipeline: draft.defaultAnalyzePipeline,
          allowedAnalyzePipelines: draft.allowedAnalyzePipelines,
          allowAnalyzeOverride: draft.allowAnalyzeOverride !== false,
        }),
      });
      const savedPolicy = normalizeProjectPipelinePolicy(response?.policy || null, normalizedProjectId);
      setProjectApiState((prev) => {
        const existing = Array.isArray(prev.policies) ? prev.policies : [];
        const others = existing.filter((item) => String(item?.projectId || '') !== normalizedProjectId);
        return {
          ...prev,
          policies: [savedPolicy, ...others],
        };
      });
      setProjectApiPolicyDrafts((prev) => ({
        ...prev,
        [normalizedProjectId]: savedPolicy,
      }));
      setBanner({ type: 'success', text: 'Pipeline policy saved.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to save pipeline policy.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, savingPolicy: '' }));
    }
  };

  const handleRevealProjectApiKey = async (projectId) => {
    if (!projectId) return;
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return;
    const isVisibleNow = visibleApiKeys?.[normalizedProjectId] === true;
    if (isVisibleNow) {
      setVisibleApiKeys((prev) => ({ ...prev, [normalizedProjectId]: false }));
      return;
    }

    clearBanner();
    setProjectApiAction((prev) => ({ ...prev, revealing: normalizedProjectId }));
    try {
      await ensureProjectApiKeyLoaded(normalizedProjectId);
      setVisibleApiKeys((prev) => ({ ...prev, [normalizedProjectId]: true }));
      setBanner({ type: 'success', text: 'API key revealed.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to reveal API key.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, revealing: '' }));
    }
  };

  const handleRegenerateProjectApiKey = async (projectId) => {
    if (!projectId) return;
    clearBanner();
    const confirmed = window.confirm('Regenerate this key now? Existing integrations using old key will stop working immediately.');
    if (!confirmed) return;

    setProjectApiAction((prev) => ({ ...prev, regenerating: projectId }));
    try {
      const response = await adminFetch(`/api/admin/project-apis/${projectId}/regenerate`, {
        method: 'POST',
      });
      if (response?.api) {
        upsertProjectApiRow(response.api);
      }
      if (response?.apiKey) {
        setProjectApiKeyCache((prev) => ({ ...prev, [projectId]: String(response.apiKey) }));
        setVisibleApiKeys((prev) => ({ ...prev, [projectId]: false }));
      }
      setBanner({ type: 'success', text: 'API key regenerated successfully.' });
    } catch (error) {
      setBanner({ type: 'error', text: error?.message || 'Failed to regenerate API key.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, regenerating: '' }));
    }
  };

  const markProjectApiFieldCopied = (projectId, field) => {
    const copiedKey = `${String(projectId || '').trim()}:${String(field || '').trim()}`;
    if (!copiedKey || copiedKey === ':') return;
    setCopiedProjectApiField(copiedKey);
    setTimeout(() => {
      setCopiedProjectApiField((prev) => (prev === copiedKey ? '' : prev));
    }, 1500);
  };

  const handleCopyProjectApiText = async (projectId, field, text) => {
    const normalizedProjectId = String(projectId || '').trim();
    const copiedText = String(text || '');
    if (!normalizedProjectId || !copiedText) return;
    try {
      await writeTextToClipboard(copiedText);
      markProjectApiFieldCopied(normalizedProjectId, field);
    } catch {
      setBanner({ type: 'error', text: 'Could not copy text. Please copy manually.' });
    }
  };

  const handleDownloadProjectApiGuide = (projectId, projectName, guideText) => {
    const normalizedProjectId = String(projectId || '').trim();
    const text = String(guideText || '');
    if (!normalizedProjectId || !text) return;

    try {
      const projectSlug = String(projectName || `project-${normalizedProjectId}`)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || `project-${normalizedProjectId}`;
      const fileName = `connectapi-${projectSlug}.txt`;
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(objectUrl);
      markProjectApiFieldCopied(normalizedProjectId, 'connect-full-guide-download');
    } catch {
      setBanner({ type: 'error', text: 'Could not download guide file.' });
    }
  };

  const handleCopyProjectApiKey = async (projectId, options = {}) => {
    const normalizedProjectId = String(projectId || '').trim();
    if (!normalizedProjectId) return;
    const showBanner = options?.showBanner !== false;
    const markField = options?.markField !== false;
    if (showBanner) clearBanner();
    setProjectApiAction((prev) => ({ ...prev, copying: normalizedProjectId }));
    try {
      const key = await ensureProjectApiKeyLoaded(normalizedProjectId);
      await writeTextToClipboard(key);
      setCopiedProjectApiId(normalizedProjectId);
      if (markField) markProjectApiFieldCopied(normalizedProjectId, 'apiKey');
      setTimeout(() => {
        setCopiedProjectApiId((prev) => (prev === normalizedProjectId ? '' : prev));
      }, 1500);
      if (showBanner) setBanner({ type: 'success', text: 'API key copied to clipboard.' });
    } catch {
      setBanner({ type: 'error', text: 'Could not copy key. Please copy manually.' });
    } finally {
      setProjectApiAction((prev) => ({ ...prev, copying: '' }));
    }
  };

  const closeConnectApiModal = useCallback(() => {
    setConnectApiProjectId('');
    setConnectApiLoadError('');
    setConnectApiLoadingKey(false);
  }, []);

  const handleOpenConnectApiModal = useCallback(async (projectRow) => {
    const projectId = String(projectRow?.projectId || '').trim();
    if (!projectId) return;
    setConnectApiProjectId(projectId);
    setConnectApiLoadError('');
    if (projectRow?.hasApi !== true) return;
    const cachedKey = String(projectApiKeyCache?.[projectId] || '').trim();
    if (cachedKey) return;
    setConnectApiLoadingKey(true);
    try {
      await ensureProjectApiKeyLoaded(projectId);
    } catch (error) {
      setConnectApiLoadError(error?.message || 'Could not load API key right now.');
    } finally {
      setConnectApiLoadingKey(false);
    }
  }, [ensureProjectApiKeyLoaded, projectApiKeyCache]);

  const toggleApiLogPreview = useCallback((logId, section) => {
    const key = `${String(logId || '')}:${String(section || '')}`;
    setExpandedApiLogRows((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const currentTabContent = useMemo(() => {
    if (activeTab === 'Users' || activeTab === 'Plans' || activeTab === 'Top Ups' || activeTab === 'Connections' || activeTab === 'Histroy' || activeTab === 'API Log') return null;
    return (
      <div className="bg-white rounded-2xl p-10 border border-slate-200 text-center text-slate-500 shadow-sm">
        <p className="text-lg font-semibold text-slate-700">{activeTab}</p>
        <p className="mt-2 text-sm">This section is now clickable and ready for the next module.</p>
      </div>
    );
  }, [activeTab]);

  return (
    <div className={`super-admin-root min-h-screen font-sans transition-colors ${isDark ? 'super-admin-theme-dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
      <style>{`
        .super-admin-theme-dark {
          --sa-bg: #020617;
          --sa-surface: #0b1220;
          --sa-surface-2: #0f172a;
          --sa-border: #22314a;
          --sa-border-soft: #1a2740;
          --sa-text: #e2e8f0;
          --sa-muted: #94a3b8;
        }
        .super-admin-theme-dark.super-admin-root {
          background:
            radial-gradient(1200px 420px at 8% -10%, rgba(14, 165, 233, 0.12), transparent 60%),
            radial-gradient(900px 320px at 95% 0%, rgba(59, 130, 246, 0.08), transparent 60%),
            var(--sa-bg);
          color: var(--sa-text);
        }
        .super-admin-theme-dark .sa-topbar {
          background-color: rgba(7, 16, 34, 0.92) !important;
          border-color: var(--sa-border) !important;
          backdrop-filter: blur(10px);
        }
        .super-admin-theme-dark .sa-panel,
        .super-admin-theme-dark .sa-subpanel {
          background-color: var(--sa-surface) !important;
          border-color: var(--sa-border) !important;
          box-shadow: 0 8px 24px rgba(2, 6, 23, 0.28);
        }
        .super-admin-theme-dark .sa-stat-card {
          background-color: var(--sa-surface) !important;
          border-color: var(--sa-border) !important;
          box-shadow: 0 8px 22px rgba(2, 6, 23, 0.26);
        }
        .super-admin-theme-dark .sa-stat-card .sa-stat-accent {
          opacity: 0.32;
          filter: saturate(80%);
        }
        .super-admin-theme-dark .sa-tabs {
          border-color: var(--sa-border) !important;
        }
        .super-admin-theme-dark .sa-tab {
          color: #9fb2cc !important;
        }
        .super-admin-theme-dark .sa-tab:hover {
          color: #dbe7ff !important;
        }
        .super-admin-theme-dark .sa-banner {
          border-color: var(--sa-border) !important;
        }
        .super-admin-theme-dark .sa-banner-error {
          background-color: rgba(127, 29, 29, 0.25) !important;
          border-color: rgba(248, 113, 113, 0.35) !important;
          color: #fecaca !important;
        }
        .super-admin-theme-dark .sa-banner-success {
          background-color: rgba(6, 78, 59, 0.25) !important;
          border-color: rgba(52, 211, 153, 0.35) !important;
          color: #a7f3d0 !important;
        }
        .super-admin-theme-dark .bg-white { background-color: #0f172a !important; }
        .super-admin-theme-dark .bg-slate-50,
        .super-admin-theme-dark .bg-slate-50\\/50,
        .super-admin-theme-dark .bg-slate-50\\/40,
        .super-admin-theme-dark .bg-slate-50\\/70 { background-color: #111827 !important; }
        .super-admin-theme-dark .sa-panel,
        .super-admin-theme-dark .sa-subpanel,
        .super-admin-theme-dark .sa-stat-card,
        .super-admin-theme-dark .sa-modal {
          background-color: var(--sa-surface) !important;
        }
        .super-admin-theme-dark .border-slate-100,
        .super-admin-theme-dark .border-slate-200,
        .super-admin-theme-dark .border-slate-300 { border-color: #334155 !important; }
        .super-admin-theme-dark .text-slate-900 { color: #f1f5f9 !important; }
        .super-admin-theme-dark .text-slate-800 { color: #e2e8f0 !important; }
        .super-admin-theme-dark .text-slate-700 { color: #cbd5e1 !important; }
        .super-admin-theme-dark .text-slate-600 { color: #94a3b8 !important; }
        .super-admin-theme-dark .text-slate-500 { color: #94a3b8 !important; }
        .super-admin-theme-dark .text-slate-400 { color: #64748b !important; }
        .super-admin-theme-dark .sa-table thead tr {
          background-color: #0a1326 !important;
        }
        .super-admin-theme-dark .sa-table td,
        .super-admin-theme-dark .sa-table th {
          border-color: var(--sa-border-soft) !important;
        }
        .super-admin-theme-dark .sa-table tbody tr:hover {
          background-color: #101d33 !important;
        }
        .super-admin-theme-dark .sa-pill {
          border: 1px solid transparent;
        }
        .super-admin-theme-dark .sa-pill-plan {
          background: rgba(245, 158, 11, 0.16) !important;
          border-color: rgba(245, 158, 11, 0.28);
          color: #fbbf24 !important;
        }
        .super-admin-theme-dark .sa-pill-role {
          background: rgba(99, 102, 241, 0.2) !important;
          border-color: rgba(129, 140, 248, 0.35);
          color: #c7d2fe !important;
        }
        .super-admin-theme-dark .sa-pill-active {
          background: rgba(16, 185, 129, 0.18) !important;
          border-color: rgba(52, 211, 153, 0.3);
          color: #6ee7b7 !important;
        }
        .super-admin-theme-dark .sa-pill-inactive {
          background: rgba(244, 63, 94, 0.18) !important;
          border-color: rgba(251, 113, 133, 0.3);
          color: #fda4af !important;
        }
        .super-admin-theme-dark .sa-modal {
          background-color: #0b1220 !important;
          border-color: var(--sa-border) !important;
        }
        .super-admin-theme-dark .sa-switch.bg-slate-300 {
          background-color: #334155 !important;
        }
        .super-admin-theme-dark .sa-icon-edit {
          border-color: rgba(59, 130, 246, 0.35) !important;
          background-color: rgba(59, 130, 246, 0.14) !important;
          color: #93c5fd !important;
        }
        .super-admin-theme-dark .sa-icon-edit:hover {
          background-color: rgba(59, 130, 246, 0.22) !important;
        }
        .super-admin-theme-dark .sa-icon-delete {
          border-color: rgba(244, 63, 94, 0.35) !important;
          background-color: rgba(244, 63, 94, 0.12) !important;
          color: #fda4af !important;
        }
        .super-admin-theme-dark .sa-icon-delete:hover {
          background-color: rgba(244, 63, 94, 0.2) !important;
        }
        .super-admin-theme-dark .sa-ghost-btn {
          background-color: #0b1220 !important;
          border-color: var(--sa-border) !important;
          color: #cbd5e1 !important;
        }
        .super-admin-theme-dark .sa-ghost-btn:hover {
          background-color: #131e33 !important;
        }
        .super-admin-theme-dark .sa-delete-dialog {
          background-color: #0b1220 !important;
          border-color: var(--sa-border) !important;
          box-shadow: 0 24px 50px rgba(2, 6, 23, 0.52);
        }
        .super-admin-theme-dark .sa-delete-overlay {
          background-color: rgba(1, 6, 18, 0.72) !important;
        }
        .super-admin-theme-dark input,
        .super-admin-theme-dark select,
        .super-admin-theme-dark textarea {
          background-color: #0b1220 !important;
          color: #e2e8f0 !important;
          border-color: #334155 !important;
        }
        .super-admin-theme-dark input::placeholder,
        .super-admin-theme-dark textarea::placeholder {
          color: #64748b !important;
        }
      `}</style>
      <header className="sa-topbar flex items-center justify-between px-8 py-4 bg-white border-b border-slate-200 sticky top-0 z-10 w-full shadow-sm">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-blue-600 text-white font-bold text-lg flex items-center justify-center shadow-md">
            S
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 leading-tight">Super Admin</h1>
            <p className="text-xs text-slate-500 font-medium">Control Center</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={toggleTheme}
            className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 transition ${
              isDark
                ? 'bg-slate-900 border-slate-700 text-slate-100 hover:bg-slate-800'
                : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
            } shadow-sm`}
            title="Toggle theme"
          >
            {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            <span className="text-xs font-semibold">{isDark ? 'Dark' : 'Light'}</span>
          </button>
          <button
            onClick={fetchData}
            className={`w-9 h-9 rounded-full border shadow-sm flex items-center justify-center transition ${
              isDark
                ? 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
            }`}
            title="Refresh data"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleLogout}
            className={`flex items-center gap-2 px-4 py-1.5 rounded-md font-medium transition ${
              isDark
                ? 'bg-rose-900/30 text-rose-300 hover:bg-rose-900/50'
                : 'bg-rose-50/50 text-rose-500 hover:bg-rose-100/50'
            }`}
          >
            <LogOut className="w-4 h-4" />
            <span className="text-sm">Logout</span>
          </button>
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-8 py-8">
        {banner.text && (
          <div
            className={`mb-6 rounded-xl border px-4 py-3 text-sm font-medium ${
              banner.type === 'error'
                ? 'sa-banner sa-banner-error border-red-200 bg-red-50 text-red-600'
                : 'sa-banner sa-banner-success border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            {banner.text}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-6 mb-12">
          <div className="sa-stat-card bg-white rounded-[20px] p-6 shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-100 relative overflow-hidden flex flex-col justify-between h-[150px]">
            <div className="sa-stat-accent absolute top-0 right-[-5px] w-28 h-full bg-sky-100/60 rounded-l-[100px] pointer-events-none"></div>
            <div className="w-11 h-11 rounded-xl bg-[#0EA5E9] text-white flex items-center justify-center mb-1 relative z-10 shadow-sm">
              <Users className="w-5 h-5" strokeWidth={2.5} />
            </div>
            <div className="relative z-10 space-y-1 mt-auto">
              <p className="text-[11px] font-bold text-slate-400 tracking-[0.1em] uppercase">Total Users</p>
              <h3 className="text-[32px] font-extrabold text-slate-800 leading-none">{isLoading ? '-' : stats?.totalUsers || 0}</h3>
            </div>
          </div>

          <div className="sa-stat-card bg-white rounded-[20px] p-6 shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-100 relative overflow-hidden flex flex-col justify-between h-[150px]">
            <div className="sa-stat-accent absolute top-0 right-[-5px] w-28 h-full bg-fuchsia-100/50 rounded-l-[100px] pointer-events-none"></div>
            <div className="w-11 h-11 rounded-xl bg-[#D946EF] text-white flex items-center justify-center mb-1 relative z-10 shadow-sm">
              <FileText className="w-5 h-5" strokeWidth={2.5} />
            </div>
            <div className="relative z-10 space-y-1 mt-auto">
              <p className="text-[11px] font-bold text-slate-400 tracking-[0.1em] uppercase">Generated Images</p>
              <h3 className="text-[32px] font-extrabold text-slate-800 leading-none">
                {isLoading ? '-' : (stats?.totalGeneratedImages ?? stats?.totalPosts ?? 0)}
              </h3>
            </div>
          </div>

          <div className="sa-stat-card bg-white rounded-[20px] p-6 shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-100 relative overflow-hidden flex flex-col justify-between h-[150px]">
            <div className="sa-stat-accent absolute top-0 right-[-5px] w-28 h-full bg-orange-100/50 rounded-l-[100px] pointer-events-none"></div>
            <div className="w-11 h-11 rounded-xl bg-[#F97316] text-white flex items-center justify-center mb-1 relative z-10 shadow-sm">
              <Clock className="w-5 h-5" strokeWidth={2.5} />
            </div>
            <div className="relative z-10 space-y-1 mt-auto">
              <p className="text-[11px] font-bold text-slate-400 tracking-[0.1em] uppercase">Pending Generations</p>
              <h3 className="text-[32px] font-extrabold text-slate-800 leading-none">
                {isLoading ? '-' : (stats?.pendingGenerations ?? stats?.pendingPosts ?? 0)}
              </h3>
            </div>
          </div>

          <div className="sa-stat-card bg-white rounded-[20px] p-6 shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-100 relative overflow-hidden flex flex-col justify-between h-[150px]">
            <div className="sa-stat-accent absolute top-0 right-[-5px] w-28 h-full bg-rose-100/50 rounded-l-[100px] pointer-events-none"></div>
            <div className="w-11 h-11 rounded-xl bg-[#EF4444] text-white flex items-center justify-center mb-1 relative z-10 shadow-sm">
              <AlertTriangle className="w-5 h-5" strokeWidth={2.5} />
            </div>
            <div className="relative z-10 space-y-1 mt-auto">
              <p className="text-[11px] font-bold text-slate-400 tracking-[0.1em] uppercase">Failed Generations</p>
              <h3 className="text-[32px] font-extrabold text-slate-800 leading-none">
                {isLoading ? '-' : (stats?.failedGenerations ?? stats?.failedPosts ?? 0)}
              </h3>
            </div>
          </div>

          <div className="sa-stat-card bg-white rounded-[20px] p-6 shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-100 relative overflow-hidden flex flex-col justify-between h-[150px]">
            <div className="sa-stat-accent absolute top-0 right-[-5px] w-28 h-full bg-emerald-100/50 rounded-l-[100px] pointer-events-none"></div>
            <div className="w-11 h-11 rounded-xl bg-[#10B981] text-white flex items-center justify-center mb-1 relative z-10 shadow-sm">
              <Database className="w-5 h-5" strokeWidth={2.5} />
            </div>
            <div className="relative z-10 space-y-1 mt-auto">
              <p className="text-[11px] font-bold text-slate-400 tracking-[0.1em] uppercase">Database Status</p>
              <h3 className="text-[28px] font-extrabold text-slate-900 leading-none mt-1 truncate">{isLoading ? '-' : stats?.dbStatus || 'Connected'}</h3>
            </div>
          </div>
        </div>

        <div className="sa-tabs flex items-center gap-8 border-b border-slate-200 mb-8 px-2">
          {TAB_LIST.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`sa-tab pb-4 text-sm font-semibold transition-colors relative ${
                activeTab === tab ? 'text-blue-600' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              {tab}
              {activeTab === tab && (
                <span className="absolute bottom-[-1px] left-0 w-full h-[3px] bg-blue-600 rounded-t-md"></span>
              )}
            </button>
          ))}
        </div>

        {activeTab === 'Users' ? (
          <div className="sa-panel bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h2 className="text-lg font-extrabold text-slate-900">User Management</h2>
                <p className="text-[13px] text-slate-500 mt-0.5">Manage system access and subscriptions.</p>
              </div>
              <button
                onClick={openAddModal}
                className="flex items-center gap-2 px-6 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-full font-semibold shadow-sm transition"
              >
                <Plus className="w-4 h-4" />
                <span className="text-sm">Add User</span>
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="sa-table w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50/50">
                    <th className="py-4 px-6 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">User Details</th>
                    <th className="py-4 px-6 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Status</th>
                    <th className="py-4 px-6 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Usage</th>
                    <th className="py-4 px-6 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Joined</th>
                    <th className="py-4 px-6 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100">Activity</th>
                    <th className="py-4 px-6 text-[11px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading ? (
                    [1, 2, 3].map((item) => (
                      <tr key={`users-skeleton-${item}`} className="animate-pulse border-b border-slate-50 last:border-b-0">
                        <td className="py-4 px-6">
                          <div className="flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-slate-200" />
                            <div className="space-y-2">
                              <div className="h-3 w-28 rounded bg-slate-200" />
                              <div className="h-3 w-40 rounded bg-slate-200" />
                              <div className="h-3 w-24 rounded bg-slate-200" />
                            </div>
                          </div>
                        </td>
                        <td className="py-4 px-6"><div className="h-6 w-20 rounded-full bg-slate-200" /></td>
                        <td className="py-4 px-6"><div className="h-4 w-24 rounded bg-slate-200" /></td>
                        <td className="py-4 px-6"><div className="h-4 w-20 rounded bg-slate-200" /></td>
                        <td className="py-4 px-6"><div className="h-4 w-20 rounded bg-slate-200" /></td>
                        <td className="py-4 px-6"><div className="ml-auto h-8 w-20 rounded-lg bg-slate-200" /></td>
                      </tr>
                    ))
                  ) : users.length === 0 ? (
                    <tr>
                      <td colSpan="6" className="py-8 text-center text-slate-500 font-medium">No users found.</td>
                    </tr>
                  ) : (
                    users.map((user, idx) => {
                      const planLabel = planNameMap[user.plan_tier] || 'Free';
                      const isUnlimitedUser = String(user.role || '').toLowerCase() === 'admin';
                      const roleLabel = user.is_super_admin
                        ? 'Super Admin'
                        : user.role === 'admin'
                          ? 'Admin'
                          : 'Member';
                      const isDeletingRow = deletingUserId === user.id;

                      return (
                        <tr
                          key={user.id || idx}
                          className={`transition border-b border-slate-50 last:border-b-0 ${isDeletingRow ? 'opacity-65 bg-rose-50/40' : ''}`}
                        >
                          <td className="py-4 px-6">
                            <div className="flex items-center gap-4">
                              <div className="w-10 h-10 rounded-full bg-slate-100 text-slate-700 font-bold flex items-center justify-center flex-shrink-0 border border-slate-200">
                                {(user.username || 'U')[0].toUpperCase()}
                              </div>
                              <div>
                                <p className="text-sm font-bold text-slate-900">{user.username}</p>
                                <p className="text-xs text-slate-500 tracking-wide mt-0.5">{user.email || 'No email'}</p>
                                <p className="text-xs text-slate-500 tracking-wide mt-0.5">{user.phone || 'No phone'}</p>
                              </div>
                            </div>
                          </td>
                          <td className="py-4 px-6">
                            <div className="flex flex-col items-start gap-1.5">
                              <span className="sa-pill sa-pill-plan inline-flex w-fit px-3 py-1 bg-amber-50 text-amber-600 text-[10px] font-bold rounded-full">
                                {planLabel}
                              </span>
                              <span className="sa-pill sa-pill-role inline-flex w-fit px-3 py-1 rounded-full bg-indigo-50 text-indigo-600 text-[10px] font-bold">
                                {roleLabel}
                              </span>
                              <span
                                className={`sa-pill inline-flex w-fit px-3 py-1 rounded-full text-[10px] font-bold ${
                                  user.is_active === false
                                    ? 'sa-pill-inactive bg-rose-50 text-rose-600'
                                    : 'sa-pill-active bg-emerald-50 text-emerald-600'
                                }`}
                              >
                                {user.is_active === false ? 'Inactive' : 'Active'}
                              </span>
                            </div>
                          </td>
                          <td className="py-4 px-6">
                            <div className="text-sm">
                              <p className="font-extrabold text-slate-800">
                                {isUnlimitedUser ? 'Unlimited' : Number(user.credits || 0)} <span className="text-xs text-slate-500 font-medium">{isUnlimitedUser ? 'Access' : 'Credits'}</span>
                              </p>
                              <p className="text-[11px] text-slate-400 font-medium whitespace-nowrap mt-0.5">
                                Monthly Quota: {isUnlimitedUser ? 'Unlimited' : Number(user.daily_credit_quota || 0)}
                              </p>
                            </div>
                          </td>
                          <td className="py-4 px-6">
                            <p className="text-[13px] text-slate-600 font-medium">
                              {formatDate(user.joined_at || user.created_at)}
                            </p>
                          </td>
                          <td className="py-4 px-6">
                            <div className="text-[13px] text-slate-600 font-medium">
                              <p>{formatDate(user.last_login_at, 'Never')}</p>
                              <p className="text-[11px] text-slate-400 mt-0.5 font-semibold tracking-wide">{formatTime(user.last_login_at, '-')}</p>
                            </div>
                          </td>
                          <td className="py-4 px-6">
                            <div className="flex items-center justify-end gap-2">
                              <button
                                onClick={() => openEditModal(user)}
                                className="sa-icon-edit p-2 rounded-lg border border-blue-100 bg-blue-50 text-blue-500 hover:bg-blue-100 transition"
                                title="Edit user"
                              >
                                <Edit2 className="w-3.5 h-3.5" />
                              </button>
                              {!user.is_super_admin && (
                                <button
                                  onClick={() => handleDeleteUser(user)}
                                  disabled={Boolean(deletingUserId)}
                                  className="sa-icon-delete p-2 rounded-lg border border-red-100 bg-red-50 text-red-500 hover:bg-red-100 transition disabled:opacity-50"
                                  title="Delete user"
                                >
                                  {isDeletingRow ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                  )}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : activeTab === 'Connections' ? (
          <div className="sa-panel bg-white rounded-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Connections</h2>
                <p className="text-sm text-slate-500 mt-1">Configure Telegram, Stripe, OpenAI, Gemini and SMTP credentials.</p>
              </div>
            </div>

            <div className="relative p-6 space-y-8">
              {isConnectionsLoading ? (
                <div className="absolute inset-0 z-10 rounded-b-[20px] bg-white/95 p-6">
                  <div className="space-y-4">
                    <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
                      <p className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Loading connections...
                      </p>
                    </div>
                    {[1, 2, 3].map((item) => (
                      <div key={`connection-skeleton-${item}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5 animate-pulse">
                        <div className="h-7 w-36 rounded bg-slate-200" />
                        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="h-10 rounded-lg bg-slate-200" />
                          <div className="h-10 rounded-lg bg-slate-200" />
                          <div className="h-10 rounded-lg bg-slate-200" />
                          <div className="h-10 rounded-lg bg-slate-200" />
                        </div>
                        <div className="mt-4 h-10 w-36 rounded-lg bg-blue-100 ml-auto" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className={isConnectionsLoading ? 'opacity-0 pointer-events-none select-none' : ''}>
              <section className="sa-subpanel rounded-2xl border border-slate-200 p-5 bg-slate-50/40">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2 text-sky-600">
                    <Send className="w-5 h-5" />
                    <h3 className="text-2xl font-extrabold">Telegram</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleConnectionToggle('telegram')}
                    className={`sa-switch relative inline-flex h-7 w-12 items-center rounded-full transition ${
                      connectionDrafts.telegram?.isEnabled ? 'bg-blue-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                        connectionDrafts.telegram?.isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Bot Username (without @)</label>
                    <input
                      value={connectionDrafts.telegram?.config?.bot_username || ''}
                      onChange={(e) => handleConnectionField('telegram', 'bot_username', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="adready_is_bot"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Bot Token</label>
                    <div className="relative">
                      <input
                        type={showSecret.telegramToken ? 'text' : 'password'}
                        value={connectionDrafts.telegram?.config?.bot_token || ''}
                        onChange={(e) => handleConnectionField('telegram', 'bot_token', e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm"
                        placeholder="123456:ABC..."
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((prev) => ({ ...prev, telegramToken: !prev.telegramToken }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showSecret.telegramToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Mode</label>
                    <select
                      value={connectionDrafts.telegram?.config?.mode || 'polling'}
                      onChange={(e) => handleConnectionField('telegram', 'mode', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="polling">polling</option>
                      <option value="webhook">webhook</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Webhook Path</label>
                    <input
                      value={connectionDrafts.telegram?.config?.webhook_path || ''}
                      onChange={(e) => handleConnectionField('telegram', 'webhook_path', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="/webhook"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Public Server URL</label>
                    <input
                      value={connectionDrafts.telegram?.config?.public_server_url || ''}
                      onChange={(e) => handleConnectionField('telegram', 'public_server_url', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="https://example.ngrok-free.app"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => handleSaveConnection('telegram')}
                    disabled={savingConnection === 'telegram'}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {savingConnection === 'telegram' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {savingConnection === 'telegram' ? 'Saving...' : 'Save Telegram'}
                  </button>
                </div>
              </section>

              <section className="sa-subpanel rounded-2xl border border-slate-200 p-5 bg-slate-50/40">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2 text-indigo-600">
                    <CreditCard className="w-5 h-5" />
                    <h3 className="text-2xl font-extrabold">Stripe</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleConnectionToggle('stripe')}
                    className={`sa-switch relative inline-flex h-7 w-12 items-center rounded-full transition ${
                      connectionDrafts.stripe?.isEnabled ? 'bg-blue-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                        connectionDrafts.stripe?.isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Publishable Key</label>
                    <input
                      value={connectionDrafts.stripe?.config?.publishable_key || ''}
                      onChange={(e) => handleConnectionField('stripe', 'publishable_key', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="pk_test_..."
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Secret Key</label>
                    <div className="relative">
                      <input
                        type={showSecret.stripeSecret ? 'text' : 'password'}
                        value={connectionDrafts.stripe?.config?.secret_key || ''}
                        onChange={(e) => handleConnectionField('stripe', 'secret_key', e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm"
                        placeholder="sk_test_..."
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((prev) => ({ ...prev, stripeSecret: !prev.stripeSecret }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showSecret.stripeSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Webhook Secret</label>
                    <div className="relative">
                      <input
                        type={showSecret.stripeWebhook ? 'text' : 'password'}
                        value={connectionDrafts.stripe?.config?.webhook_secret || ''}
                        onChange={(e) => handleConnectionField('stripe', 'webhook_secret', e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm"
                        placeholder="whsec_..."
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((prev) => ({ ...prev, stripeWebhook: !prev.stripeWebhook }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showSecret.stripeWebhook ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Payment Redirect URL (Frontend)</label>
                    <input
                      value={connectionDrafts.stripe?.config?.payment_redirect_url || ''}
                      onChange={(e) => handleConnectionField('stripe', 'payment_redirect_url', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="https://your-domain/#/dashboard"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => handleSaveConnection('stripe')}
                    disabled={savingConnection === 'stripe'}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {savingConnection === 'stripe' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {savingConnection === 'stripe' ? 'Saving...' : 'Save Stripe'}
                  </button>
                </div>
              </section>

              <section className="sa-subpanel rounded-2xl border border-slate-200 p-5 bg-slate-50/40">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2 text-emerald-600">
                    <Bot className="w-5 h-5" />
                    <h3 className="text-2xl font-extrabold">OpenAI</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleConnectionToggle('openai')}
                    className={`sa-switch relative inline-flex h-7 w-12 items-center rounded-full transition ${
                      connectionDrafts.openai?.isEnabled ? 'bg-blue-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                        connectionDrafts.openai?.isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">API Key</label>
                    <div className="relative">
                      <input
                        type={showSecret.openaiApi ? 'text' : 'password'}
                        value={connectionDrafts.openai?.config?.api_key || ''}
                        onChange={(e) => handleConnectionField('openai', 'api_key', e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm"
                        placeholder="sk-..."
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((prev) => ({ ...prev, openaiApi: !prev.openaiApi }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showSecret.openaiApi ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Text Model</label>
                    <input
                      value={connectionDrafts.openai?.config?.model || ''}
                      onChange={(e) => handleConnectionField('openai', 'model', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="gpt-4o"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Image Model</label>
                    <input
                      value={connectionDrafts.openai?.config?.image_model || ''}
                      onChange={(e) => handleConnectionField('openai', 'image_model', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="gpt-image-1"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Base URL (Optional)</label>
                    <input
                      value={connectionDrafts.openai?.config?.base_url || ''}
                      onChange={(e) => handleConnectionField('openai', 'base_url', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="https://api.openai.com/v1"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Text URL Override (Optional)</label>
                    <input
                      value={connectionDrafts.openai?.config?.text_url || ''}
                      onChange={(e) => handleConnectionField('openai', 'text_url', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder=""
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => handleSaveConnection('openai')}
                    disabled={savingConnection === 'openai'}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {savingConnection === 'openai' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {savingConnection === 'openai' ? 'Saving...' : 'Save OpenAI'}
                  </button>
                </div>
              </section>

              <section className="sa-subpanel rounded-2xl border border-slate-200 p-5 bg-slate-50/40">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2 text-fuchsia-600">
                    <Sparkles className="w-5 h-5" />
                    <h3 className="text-2xl font-extrabold">Gemini</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleConnectionToggle('gemini')}
                    className={`sa-switch relative inline-flex h-7 w-12 items-center rounded-full transition ${
                      connectionDrafts.gemini?.isEnabled ? 'bg-blue-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                        connectionDrafts.gemini?.isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">API Key</label>
                    <div className="relative">
                      <input
                        type={showSecret.geminiApi ? 'text' : 'password'}
                        value={connectionDrafts.gemini?.config?.api_key || ''}
                        onChange={(e) => handleConnectionField('gemini', 'api_key', e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm"
                        placeholder="AIza..."
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((prev) => ({ ...prev, geminiApi: !prev.geminiApi }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showSecret.geminiApi ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Default Model</label>
                    <input
                      value={connectionDrafts.gemini?.config?.model || ''}
                      onChange={(e) => handleConnectionField('gemini', 'model', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="gemini-2.5-flash"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Text Model</label>
                    <input
                      value={connectionDrafts.gemini?.config?.text_model || ''}
                      onChange={(e) => handleConnectionField('gemini', 'text_model', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="gemini-2.5-flash"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Vision Model</label>
                    <input
                      value={connectionDrafts.gemini?.config?.vision_model || ''}
                      onChange={(e) => handleConnectionField('gemini', 'vision_model', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder=""
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Image Model</label>
                    <input
                      value={connectionDrafts.gemini?.config?.image_model || ''}
                      onChange={(e) => handleConnectionField('gemini', 'image_model', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="gemini-2.5-flash-image"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Image MIME</label>
                    <input
                      value={connectionDrafts.gemini?.config?.image_mime || ''}
                      onChange={(e) => handleConnectionField('gemini', 'image_mime', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="image/png"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Image URL (Optional)</label>
                    <input
                      value={connectionDrafts.gemini?.config?.image_url || ''}
                      onChange={(e) => handleConnectionField('gemini', 'image_url', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder=""
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Fallback Image URL (Optional)</label>
                    <input
                      value={connectionDrafts.gemini?.config?.image_fallback_url || ''}
                      onChange={(e) => handleConnectionField('gemini', 'image_fallback_url', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder=""
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => handleSaveConnection('gemini')}
                    disabled={savingConnection === 'gemini'}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {savingConnection === 'gemini' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {savingConnection === 'gemini' ? 'Saving...' : 'Save Gemini'}
                  </button>
                </div>
              </section>

              <section className="sa-subpanel rounded-2xl border border-slate-200 p-5 bg-slate-50/40">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-2 text-amber-600">
                    <Mail className="w-5 h-5" />
                    <h3 className="text-2xl font-extrabold">SMTP Email</h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleConnectionToggle('smtp')}
                    className={`sa-switch relative inline-flex h-7 w-12 items-center rounded-full transition ${
                      connectionDrafts.smtp?.isEnabled ? 'bg-blue-600' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                        connectionDrafts.smtp?.isEnabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">SMTP Host</label>
                    <input
                      value={connectionDrafts.smtp?.config?.host || ''}
                      onChange={(e) => handleConnectionField('smtp', 'host', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="mail.example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">SMTP Port</label>
                    <input
                      value={connectionDrafts.smtp?.config?.port || ''}
                      onChange={(e) => handleConnectionField('smtp', 'port', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="465"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">Secure</label>
                    <select
                      value={connectionDrafts.smtp?.config?.secure || 'true'}
                      onChange={(e) => handleConnectionField('smtp', 'secure', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">SMTP User</label>
                    <input
                      value={connectionDrafts.smtp?.config?.user || ''}
                      onChange={(e) => handleConnectionField('smtp', 'user', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="no-reply@example.com"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">SMTP Password</label>
                    <div className="relative">
                      <input
                        type={showSecret.smtpPass ? 'text' : 'password'}
                        value={connectionDrafts.smtp?.config?.pass || ''}
                        onChange={(e) => handleConnectionField('smtp', 'pass', e.target.value)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 pr-10 text-sm"
                        placeholder=""
                      />
                      <button
                        type="button"
                        onClick={() => setShowSecret((prev) => ({ ...prev, smtpPass: !prev.smtpPass }))}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                      >
                        {showSecret.smtpPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-600 mb-1">From Address</label>
                    <input
                      value={connectionDrafts.smtp?.config?.from || ''}
                      onChange={(e) => handleConnectionField('smtp', 'from', e.target.value)}
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      placeholder="AdReady <no-reply@example.com>"
                    />
                  </div>
                </div>

                <div className="mt-4 flex justify-end">
                  <button
                    onClick={() => handleSaveConnection('smtp')}
                    disabled={savingConnection === 'smtp'}
                    className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60"
                  >
                    {savingConnection === 'smtp' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {savingConnection === 'smtp' ? 'Saving...' : 'Save SMTP'}
                  </button>
                </div>
              </section>
              </div>
            </div>
          </div>
        ) : activeTab === 'API' ? (
          <div className="sa-panel bg-white rounded-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-200 overflow-hidden">
            <div className="relative overflow-hidden border-b border-slate-100 bg-gradient-to-r from-white via-slate-50 to-emerald-50/50">
              <div className="pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-emerald-100/40 blur-2xl" />
              <div className="pointer-events-none absolute -left-10 bottom-0 h-24 w-24 rounded-full bg-blue-100/40 blur-2xl" />
              <div className="relative flex flex-col gap-4 p-6 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">Project API Workspace</p>
                  <h2 className="mt-1 text-xl font-extrabold text-slate-900">API Control Center</h2>
                  <p className="mt-1.5 text-sm text-slate-600">Create projects, issue API keys, and control external access from a single place.</p>
                </div>
                <button
                  onClick={openCreateProjectModal}
                  className="inline-flex h-[44px] items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-5 text-sm font-semibold text-emerald-700 shadow-sm hover:bg-emerald-100"
                >
                  <Plus className="h-4 w-4" />
                  Create Project
                </button>
              </div>
            </div>

            <div className="relative p-6 space-y-4">
              {isProjectApisLoading ? (
                <div className="absolute inset-0 z-10 rounded-b-[20px] bg-white/95 p-6">
                  <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
                    <p className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading API workspace...
                    </p>
                  </div>
                  <div className="mt-4 space-y-3">
                    {[1, 2].map((item) => (
                      <div key={`api-skeleton-${item}`} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-5 animate-pulse">
                        <div className="h-4 w-40 rounded bg-slate-200" />
                        <div className="mt-3 h-10 w-full rounded-lg bg-slate-200" />
                        <div className="mt-3 h-10 w-full rounded-lg bg-slate-200" />
                        <div className="mt-3 h-40 w-full rounded-xl bg-slate-200" />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <div className={isProjectApisLoading ? 'opacity-0 pointer-events-none select-none' : ''}>
              <div className="sa-subpanel rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 to-white p-5 space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Generate Endpoint</p>
                    <p className="mt-1 text-sm font-mono text-slate-700 break-all">{projectApiState.sharedEndpointUrl || projectApiState.sharedEndpointPath}</p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Analyze Endpoint</p>
                    <p className="mt-1 text-sm font-mono text-slate-700 break-all">{projectApiState.sharedAnalyzeEndpointUrl || projectApiState.sharedAnalyzeEndpointPath}</p>
                  </div>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white/90 px-3 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Global Runtime Controls</p>
                    <button
                      onClick={handleSaveProjectApiRuntime}
                      disabled={projectApiAction.savingRuntime}
                      className="inline-flex h-8 items-center justify-center gap-1 rounded-lg border border-blue-300 bg-blue-50 px-3 text-xs font-semibold text-blue-700 hover:bg-blue-100 disabled:opacity-60"
                    >
                      {projectApiAction.savingRuntime ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      {projectApiAction.savingRuntime ? 'Saving...' : 'Save Runtime'}
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                    <button
                      onClick={() => handleProjectApiRuntimeDraftToggle('externalGenerateEnabled')}
                      className="flex items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-xs font-semibold text-slate-700"
                      type="button"
                    >
                      <span>External Generate</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        projectApiRuntimeDraft?.externalGenerateEnabled !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'
                      }`}>
                        {projectApiRuntimeDraft?.externalGenerateEnabled !== false ? 'ON' : 'OFF'}
                      </span>
                    </button>
                    <button
                      onClick={() => handleProjectApiRuntimeDraftToggle('externalAnalyzeEnabled')}
                      className="flex items-center justify-between rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-xs font-semibold text-slate-700"
                      type="button"
                    >
                      <span>External Analyze</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        projectApiRuntimeDraft?.externalAnalyzeEnabled !== false ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-600'
                      }`}>
                        {projectApiRuntimeDraft?.externalAnalyzeEnabled !== false ? 'ON' : 'OFF'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>

              {projectApiRows.length === 0 ? (
                <div className="sa-subpanel rounded-2xl border border-slate-200 bg-slate-50/50 p-6 text-center">
                  <p className="text-sm font-medium text-slate-600">No projects yet. Click <span className="font-semibold text-slate-800">Create Project</span> to get started.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {projectApiRows.map((row) => {
                    const projectId = String(row.projectId || '');
                    const hasApi = row.hasApi === true;
                    const isManualProject = String(row.sourceType || 'manual') === 'manual';
                    const cachedKey = String(projectApiKeyCache?.[projectId] || '');
                    const isKeyVisible = visibleApiKeys?.[projectId] === true;
                    const keyText = hasApi
                      ? (isKeyVisible
                        ? (cachedKey || row.keyPreview || `${row.keyPrefix || 'adr_'}****${row.keyLast4 || ''}`)
                        : (row.keyPreview || `${row.keyPrefix || 'adr_'}****${row.keyLast4 || ''}`))
                      : 'No API key generated';
                    const isGenerating = projectApiAction.creating === projectId;
                    const isRevealing = projectApiAction.revealing === projectId;
                    const isRegenerating = projectApiAction.regenerating === projectId;
                    const isToggling = projectApiAction.toggling === projectId;
                    const isCopying = projectApiAction.copying === projectId;
                    const isDeletingProject = projectApiAction.deletingProject === projectId;
                    const isSavingPolicy = projectApiAction.savingPolicy === projectId;
                    const isCopied = copiedProjectApiId === projectId;
                    const endpointCopied = copiedProjectApiField === `${projectId}:endpoint`;
                    const apiKeyFieldCopied = copiedProjectApiField === `${projectId}:apiKey`;
                    const policyDraft = normalizeProjectPipelinePolicy(
                      projectApiPolicyDrafts?.[projectId] || row.policy || null,
                      projectId
                    );
                    const generatePipelineCatalog = sanitizePipelineList(
                      projectApiState?.pipelineCatalog?.generate,
                      GENERATE_PIPELINE_OPTIONS
                    ).filter((item) => GENERATE_PIPELINE_OPTIONS.includes(item));
                    const analyzePipelineCatalog = sanitizePipelineList(
                      projectApiState?.pipelineCatalog?.analyze,
                      ANALYZE_PIPELINE_OPTIONS
                    ).filter((item) => ANALYZE_PIPELINE_OPTIONS.includes(item));
                    return (
                      <div
                        key={projectId}
                        className="sa-subpanel rounded-[24px] border border-slate-200 bg-gradient-to-b from-white to-slate-50/70 p-5 shadow-[0_16px_38px_-30px_rgba(15,23,42,0.75)]"
                      >
                        <div className="grid grid-cols-12 gap-4">
                          <div className="col-span-12 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/80 pb-4">
                            <div className="flex min-w-0 items-center gap-3">
                              <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-600 text-sm font-bold text-white">
                                {String(row.projectName || 'P').trim().charAt(0).toUpperCase() || 'P'}
                              </div>
                              <div className="min-w-0">
                                <h3 className="truncate text-2xl font-bold leading-tight tracking-tight text-slate-900">{row.projectName || 'Prachar AI'}</h3>
                                <div className="mt-1 flex flex-wrap items-center gap-2">
                                  <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                                    String(row.projectStatus || 'active').toLowerCase() === 'active'
                                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                                      : 'border-rose-200 bg-rose-50 text-rose-600'
                                  }`}>
                                    {String(row.projectStatus || 'active').toLowerCase() === 'active' ? 'Active' : 'Inactive'}
                                  </span>
                                  <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] font-semibold ${
                                    !hasApi
                                      ? 'border-slate-300 bg-slate-100 text-slate-600'
                                      : row.isEnabled
                                        ? 'border-sky-200 bg-sky-50 text-sky-700'
                                        : 'border-slate-300 bg-slate-100 text-slate-600'
                                  }`}>
                                    {!hasApi ? 'Key Missing' : row.isEnabled ? 'Enabled' : 'Disabled'}
                                  </span>
                                </div>
                              </div>
                            </div>

                            <div className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Access Control</p>
                              <button
                                onClick={() => handleToggleProjectApi(projectId, !row.isEnabled)}
                                disabled={!hasApi || isToggling}
                                className={`sa-switch relative inline-flex h-7 w-12 items-center rounded-full transition ${
                                  row.isEnabled ? 'bg-indigo-600' : 'bg-slate-300'
                                } disabled:opacity-60`}
                                title={!hasApi ? 'Generate API first' : row.isEnabled ? 'Disable API' : 'Enable API'}
                              >
                                {isToggling ? (
                                  <Loader2 className="mx-auto h-4 w-4 animate-spin text-white" />
                                ) : (
                                  <span
                                    className={`inline-block h-5 w-5 transform rounded-full bg-white transition ${
                                      row.isEnabled ? 'translate-x-6' : 'translate-x-1'
                                    }`}
                                  />
                                )}
                              </button>
                            </div>
                          </div>

                          <div className="col-span-12 grid grid-cols-1 gap-3 lg:grid-cols-2">
                            <div className="rounded-2xl border border-slate-800/60 bg-slate-900 p-3.5">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">Endpoint</p>
                              <button
                                type="button"
                                onClick={() => handleCopyProjectApiText(projectId, 'endpoint', projectApiState.sharedEndpointPath)}
                                className="relative mt-2 block w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-left font-mono text-[13px] font-medium text-slate-100 transition-colors hover:border-indigo-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30"
                                title="Copy endpoint"
                              >
                                <span className="block break-all pr-16">
                                {projectApiState.sharedEndpointPath}
                                </span>
                                {endpointCopied ? (
                                  <span className="absolute right-2 top-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                                    Copied
                                  </span>
                                ) : null}
                              </button>
                            </div>
                            <div className="rounded-2xl border border-slate-800/60 bg-slate-900 p-3.5">
                              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">API Key</p>
                              <button
                                type="button"
                                onClick={() => handleCopyProjectApiKey(projectId, { showBanner: false })}
                                disabled={!hasApi || isCopying}
                                className={`relative mt-2 block w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-left text-[13px] transition-colors hover:border-indigo-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 disabled:cursor-not-allowed disabled:hover:border-slate-700 ${
                                hasApi ? 'font-mono font-medium text-indigo-100' : 'font-medium text-slate-400'
                              }`}>
                                <span className="block break-all pr-16">
                                {keyText}
                                </span>
                                {apiKeyFieldCopied ? (
                                  <span className="absolute right-2 top-1.5 rounded-md border border-emerald-400/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200">
                                    Copied
                                  </span>
                                ) : null}
                              </button>
                            </div>
                          </div>

                          <div className="col-span-12">
                            {hasApi ? (
                              <p className="text-[11px] text-slate-500">
                                Rotated: {formatDate(row.rotatedAt, '-')} {formatTime(row.rotatedAt, '')} | Last used: {formatDate(row.lastUsedAt, '-')} {formatTime(row.lastUsedAt, '')}
                              </p>
                            ) : (
                              <p className="text-[11px] text-slate-500">Click Generate to create the first key for this project.</p>
                            )}
                          </div>

                          <div className="col-span-12 grid grid-cols-12 gap-3 border-t border-slate-200/80 pt-3">
                            <div className="col-span-12 xl:col-span-8 rounded-2xl border border-slate-200 bg-white/80 p-4">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Pipeline Policy</p>
                                <button
                                  type="button"
                                  onClick={() => handleSaveProjectApiPolicy(projectId)}
                                  disabled={isSavingPolicy}
                                  className="inline-flex h-9 items-center justify-center gap-1 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-60"
                                >
                                  {isSavingPolicy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                  {isSavingPolicy ? 'Saving...' : 'Save Policy'}
                                </button>
                              </div>

                              <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
                                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3">
                                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Generate</p>
                                  <div className="mt-2.5">
                                    <label className="block text-[11px] font-semibold text-slate-500">Fallback Pipeline</label>
                                    <select
                                      value={policyDraft.defaultGeneratePipeline}
                                      onChange={(e) => handleProjectPolicyField(projectId, 'defaultGeneratePipeline', e.target.value)}
                                      className="mt-1.5 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                                    >
                                      {generatePipelineCatalog.map((pipeline) => (
                                        <option
                                          key={`${projectId}:generate-default:${pipeline}`}
                                          value={pipeline}
                                        >
                                          {getPipelineDisplayName(pipeline)}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleProjectPolicyField(projectId, 'allowGenerateOverride', !policyDraft.allowGenerateOverride)}
                                    className={`mt-3 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                                      policyDraft.allowGenerateOverride
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                        : 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
                                    }`}
                                  >
                                    Override: {policyDraft.allowGenerateOverride ? 'Allowed' : 'Blocked'}
                                  </button>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {generatePipelineCatalog.map((pipeline) => {
                                      const active = policyDraft.allowedGeneratePipelines.includes(pipeline);
                                      return (
                                        <button
                                          key={`${projectId}:generate-allow:${pipeline}`}
                                          type="button"
                                          aria-pressed={active}
                                          onClick={() => handleProjectPolicyToggleAllowed(projectId, 'generate', pipeline)}
                                          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
                                            active
                                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                              : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400 hover:bg-slate-50'
                                          }`}
                                        >
                                          <span>{getPipelineDisplayName(pipeline)}</span>
                                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                                            active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                                          }`}>
                                            {active ? 'On' : 'Off'}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>

                                <div className="rounded-xl border border-slate-200 bg-slate-50/60 px-3.5 py-3">
                                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Analyze</p>
                                  <div className="mt-2.5">
                                    <label className="block text-[11px] font-semibold text-slate-500">Fallback Pipeline</label>
                                    <select
                                      value={policyDraft.defaultAnalyzePipeline}
                                      onChange={(e) => handleProjectPolicyField(projectId, 'defaultAnalyzePipeline', e.target.value)}
                                      className="mt-1.5 h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200"
                                    >
                                      {analyzePipelineCatalog.map((pipeline) => (
                                        <option
                                          key={`${projectId}:analyze-default:${pipeline}`}
                                          value={pipeline}
                                        >
                                          {getPipelineDisplayName(pipeline)}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                  <button
                                    type="button"
                                    onClick={() => handleProjectPolicyField(projectId, 'allowAnalyzeOverride', !policyDraft.allowAnalyzeOverride)}
                                    className={`mt-3 inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                                      policyDraft.allowAnalyzeOverride
                                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                        : 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100'
                                    }`}
                                  >
                                    Override: {policyDraft.allowAnalyzeOverride ? 'Allowed' : 'Blocked'}
                                  </button>
                                  <div className="mt-3 flex flex-wrap gap-2">
                                    {analyzePipelineCatalog.map((pipeline) => {
                                      const active = policyDraft.allowedAnalyzePipelines.includes(pipeline);
                                      return (
                                        <button
                                          key={`${projectId}:analyze-allow:${pipeline}`}
                                          type="button"
                                          aria-pressed={active}
                                          onClick={() => handleProjectPolicyToggleAllowed(projectId, 'analyze', pipeline)}
                                          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-all duration-200 hover:-translate-y-0.5 hover:shadow-sm ${
                                            active
                                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                                              : 'border-slate-300 bg-white text-slate-500 hover:border-slate-400 hover:bg-slate-50'
                                          }`}
                                        >
                                          <span>{getPipelineDisplayName(pipeline)}</span>
                                          <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                                            active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                                          }`}>
                                            {active ? 'On' : 'Off'}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              </div>
                            </div>

                            <div className="col-span-12 xl:col-span-4 rounded-2xl border border-slate-200 bg-white p-4">
                              <div className="grid grid-cols-2 gap-2">
                                <button
                                  onClick={() => handleRevealProjectApiKey(projectId)}
                                  disabled={!hasApi || isRevealing}
                                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                                >
                                  {isRevealing ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : isKeyVisible ? (
                                    <EyeOff className="h-3.5 w-3.5" />
                                  ) : (
                                    <Eye className="h-3.5 w-3.5" />
                                  )}
                                  {isKeyVisible ? 'Hide' : 'Reveal'}
                                </button>
                                <button
                                  onClick={() => handleCopyProjectApiKey(projectId)}
                                  disabled={!hasApi || isCopying}
                                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-60"
                                >
                                  {isCopying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clipboard className="h-3.5 w-3.5" />}
                                  {isCopied ? 'Copied' : 'Copy'}
                                </button>

                                {hasApi ? (
                                  <button
                                    onClick={() => handleRegenerateProjectApiKey(projectId)}
                                    disabled={isRegenerating}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-100 disabled:opacity-60"
                                  >
                                    {isRegenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                    Regenerate
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleGenerateProjectApi(projectId)}
                                    disabled={isGenerating}
                                    className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-60"
                                  >
                                    {isGenerating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                                    {isGenerating ? 'Generating...' : 'Generate'}
                                  </button>
                                )}
                                <button
                                  onClick={() => handleDeleteProject(projectId, row.projectName)}
                                  disabled={!isManualProject || isDeletingProject}
                                  className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-rose-300 bg-rose-50/70 px-3 text-xs font-semibold text-rose-700 transition-colors hover:bg-rose-100 disabled:opacity-60"
                                  title={!isManualProject ? 'Only manual projects can be deleted here' : 'Delete project'}
                                >
                                  {isDeletingProject ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                  {isDeletingProject ? 'Deleting...' : 'Delete'}
                                </button>
                                <button
                                  onClick={() => handleOpenConnectApiModal(row)}
                                  className="col-span-2 inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 text-xs font-semibold text-indigo-700 transition-colors hover:bg-indigo-100"
                                  title="Open API integration guide"
                                  type="button"
                                >
                                  <FileText className="h-3.5 w-3.5" />
                                  ConnectAPI
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            </div>
          </div>
        ) : activeTab === 'API Log' ? (
          <div className="sa-panel bg-white rounded-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-200 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 p-6 border-b border-slate-100">
              <div>
                <h2 className="text-xl font-bold text-slate-900">API Log</h2>
                <p className="text-sm text-slate-500 mt-1">
                  External endpoint activity for debugging. Auto-retention: last {apiLogRetentionDays} days.
                </p>
              </div>
              <button
                type="button"
                onClick={() => fetchApiLogs({ showSpinner: true })}
                disabled={isApiLogsLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${isApiLogsLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/50 p-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Level</label>
                  <select
                    value={apiLogFilters.level}
                    onChange={(e) => setApiLogFilters((prev) => ({ ...prev, level: e.target.value }))}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="all">All</option>
                    <option value="info">Info</option>
                    <option value="error">Error</option>
                  </select>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Project</label>
                  <select
                    value={apiLogFilters.projectId}
                    onChange={(e) => setApiLogFilters((prev) => ({ ...prev, projectId: e.target.value }))}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="all">All Projects</option>
                    {apiLogProjectOptions.map((item) => (
                      <option key={item.projectId} value={item.projectId}>
                        {item.projectName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {apiLogsError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-600">
                  {apiLogsError}
                </div>
              ) : null}

              {isApiLogsLoading ? (
                <div className="py-10 text-center text-slate-500 font-medium">Loading API logs...</div>
              ) : apiLogs.length === 0 ? (
                <div className="py-10 text-center text-slate-500 font-medium">No API log entries found for this filter.</div>
              ) : (
                <div className="space-y-3">
                  {apiLogs.map((entry, index) => {
                    const logId = String(entry?.id || `log-${index}`);
                    const statusCode = Number(entry?.statusCode || 0);
                    const isError = String(entry?.level || '').toLowerCase() === 'error' || statusCode >= 400;
                    const requestKey = `${logId}:request`;
                    const responseKey = `${logId}:response`;
                    const requestPreviewText = toPrettyJson(entry?.requestPreview || {});
                    const responsePreviewText = toPrettyJson(entry?.responsePreview || {});
                    return (
                      <div key={logId} className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold uppercase text-slate-600">
                                {String(entry?.method || 'POST').toUpperCase()}
                              </span>
                              <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase ${
                                isError ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-700'
                              }`}>
                                {isError ? 'Error' : 'Info'}
                              </span>
                              <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold ${
                                isError ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-300 bg-white text-slate-700'
                              }`}>
                                {statusCode || '-'}
                              </span>
                              <span className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700">
                                {Number.isFinite(Number(entry?.latencyMs)) ? `${Number(entry.latencyMs)} ms` : '-'}
                              </span>
                            </div>
                            <p className="text-sm font-semibold text-slate-800 break-all">{String(entry?.endpointPath || '/api/external/generate')}</p>
                            <p className="text-xs text-slate-500">
                              Project: <span className="font-semibold text-slate-700">{String(entry?.projectName || 'Unknown Project')}</span>
                              {' | '}
                              Source: <span className="font-semibold text-slate-700">{String(entry?.source || 'n/a')}</span>
                            </p>
                            <p className="text-xs text-slate-500">
                              {formatDate(entry?.createdAt, '-')} {formatTime(entry?.createdAt, '-')}
                            </p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => toggleApiLogPreview(logId, 'request')}
                              className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              {expandedApiLogRows[requestKey] ? 'Hide Request' : 'Show Request'}
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleApiLogPreview(logId, 'response')}
                              className="inline-flex h-8 items-center justify-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                            >
                              {expandedApiLogRows[responseKey] ? 'Hide Response' : 'Show Response'}
                            </button>
                          </div>
                        </div>

                        {entry?.errorText ? (
                          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2">
                            <p className="text-xs font-semibold uppercase tracking-wide text-red-600">Error</p>
                            <p className="mt-1 text-sm text-red-700 break-words">{String(entry.errorText)}</p>
                          </div>
                        ) : null}

                        {expandedApiLogRows[requestKey] ? (
                          <div className="mt-3 rounded-lg border border-slate-200 bg-white overflow-hidden">
                            <div className="px-3 py-2 border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Request Preview
                            </div>
                            <pre className="m-0 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto max-h-80 whitespace-pre-wrap break-all">{requestPreviewText}</pre>
                          </div>
                        ) : null}

                        {expandedApiLogRows[responseKey] ? (
                          <div className="mt-3 rounded-lg border border-slate-200 bg-white overflow-hidden">
                            <div className="px-3 py-2 border-b border-slate-100 text-xs font-semibold uppercase tracking-wide text-slate-500">
                              Response Preview
                            </div>
                            <pre className="m-0 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto max-h-80 whitespace-pre-wrap break-all">{responsePreviewText}</pre>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : activeTab === 'Plans' ? (
          <div className="sa-panel bg-white rounded-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Plan Management</h2>
                <p className="text-sm text-slate-500 mt-1">Edit plan name, price and monthly credits.</p>
              </div>
            </div>

            <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {isPlansLoading ? (
                [1, 2, 3].map((item) => (
                  <div key={`plan-skeleton-${item}`} className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/40 p-4 animate-pulse">
                    <div className="h-10 w-28 rounded bg-slate-200" />
                    <div className="mt-3 h-4 w-52 rounded bg-slate-200" />
                    <div className="mt-4 space-y-3">
                      <div className="h-3 w-24 rounded bg-slate-200" />
                      <div className="h-10 w-full rounded-lg bg-slate-200" />
                      <div className="h-3 w-28 rounded bg-slate-200" />
                      <div className="h-10 w-full rounded-lg bg-slate-200" />
                      <div className="h-3 w-28 rounded bg-slate-200" />
                      <div className="h-10 w-full rounded-lg bg-slate-200" />
                    </div>
                    <div className="mt-4 flex gap-2">
                      <div className="h-10 flex-1 rounded-lg bg-blue-100" />
                      <div className="h-10 w-16 rounded-lg bg-rose-100" />
                    </div>
                  </div>
                ))
              ) : plans.length === 0 ? (
                <div className="sa-subpanel col-span-full rounded-xl border border-slate-200 bg-slate-50/40 p-6 text-sm font-medium text-slate-500">
                  No plan data loaded yet. Try refresh.
                </div>
              ) : plans.map((plan) => {
                const draft = planDrafts[plan.tier] || {
                  name: plan.name,
                  priceUsdMonthly: String(plan.priceUsdMonthly ?? ''),
                  monthlyCredits: String(plan.monthlyCredits ?? ''),
                };
                const isSaving = savingPlanTier === plan.tier;

                return (
                  <div key={plan.tier} className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-[32px] font-extrabold text-slate-900">{planNameMap[plan.tier] || plan.tier}</h3>
                      <span className="text-xs font-semibold text-slate-500 uppercase">{plan.tier}</span>
                    </div>
                    <p className="mt-1 text-sm text-slate-500">
                      Current: ${Number(plan.priceUsdMonthly || 0)}/month, {Number(plan.monthlyCredits || 0)} credits
                    </p>

                    <div className="mt-4 space-y-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Plan Name</label>
                        <input
                          value={draft.name}
                          onChange={(e) => handlePlanDraftChange(plan.tier, 'name', e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Price (USD / month)</label>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          value={draft.priceUsdMonthly}
                          onChange={(e) => handlePlanDraftChange(plan.tier, 'priceUsdMonthly', e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Monthly Credits</label>
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={draft.monthlyCredits}
                          onChange={(e) => handlePlanDraftChange(plan.tier, 'monthlyCredits', e.target.value)}
                          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                        />
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-2">
                      <button
                        onClick={() => handleSavePlan(plan.tier)}
                        disabled={isSaving}
                        className={`relative overflow-hidden flex-1 rounded-lg px-3 py-2 text-sm font-semibold text-white transition-all duration-200 ${
                          isSaving
                            ? 'bg-blue-500 cursor-wait'
                            : 'bg-blue-600 hover:bg-blue-700 active:scale-[0.99]'
                        } disabled:opacity-90`}
                      >
                        {isSaving && (
                          <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-blue-400/10 via-white/25 to-blue-400/10" />
                        )}
                        <span className="relative z-10 inline-flex items-center justify-center gap-2">
                          {isSaving ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              Saving...
                            </>
                          ) : (
                            'Save Plan'
                          )}
                        </span>
                      </button>
                      <button
                        onClick={() => handleResetPlan(plan.tier)}
                        disabled={isSaving}
                        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-500 hover:bg-rose-100 disabled:opacity-60"
                      >
                        Reset
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : activeTab === 'Top Ups' ? (
          <div className="sa-panel bg-white rounded-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-slate-100 gap-3 flex-wrap">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Top-up Package Management</h2>
                <p className="text-sm text-slate-500 mt-1">Manage one-time credit packs shown on Telegram buy prompt.</p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleAddTopupDraft}
                  disabled={isTopupsLoading}
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Plus className="h-4 w-4" />
                  Add Package
                </button>
              </div>
            </div>

            <div className="p-6 space-y-3">
              {isTopupsLoading ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3">
                    <p className="inline-flex items-center gap-2 text-sm font-semibold text-blue-700">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading top-up packages...
                    </p>
                  </div>
                  {[1, 2, 3].map((item) => (
                    <div key={`topup-skeleton-${item}`} className="rounded-xl border border-slate-200 bg-slate-50/40 p-4 animate-pulse">
                      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                        <div className="md:col-span-3 space-y-2">
                          <div className="h-3 w-16 rounded bg-slate-200" />
                          <div className="h-10 w-full rounded-lg bg-slate-200" />
                        </div>
                        <div className="md:col-span-3 space-y-2">
                          <div className="h-3 w-20 rounded bg-slate-200" />
                          <div className="h-10 w-full rounded-lg bg-slate-200" />
                        </div>
                        <div className="md:col-span-3 space-y-2">
                          <div className="h-3 w-14 rounded bg-slate-200" />
                          <div className="h-10 w-full rounded-lg bg-emerald-100" />
                        </div>
                        <div className="md:col-span-3 flex md:justify-end">
                          <div className="h-10 w-28 rounded-lg bg-rose-100" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : topupDrafts.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-6 text-sm font-medium text-slate-500">
                  No top-up package found. Click Add Package to create one.
                </div>
              ) : topupDrafts.map((pack, index) => (
                <div key={`${pack.credits || 'new'}-${index}`} className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/40 p-4">
                  {(() => {
                    const rowCredits = Math.floor(Number(pack.credits));
                    const rowKey = `${Number.isFinite(rowCredits) ? rowCredits : 'new'}-${index}`;
                    const isRemoving = removingTopupKey === rowKey;
                    return (
                  <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
                    <div className="md:col-span-3">
                      <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Credits</label>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={pack.credits}
                        onChange={(e) => handleTopupDraftChange(index, 'credits', e.target.value)}
                        disabled={isRemoving}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                      />
                    </div>
                    <div className="md:col-span-3">
                      <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Price (USD)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={pack.priceUsd}
                        onChange={(e) => handleTopupDraftChange(index, 'priceUsd', e.target.value)}
                        disabled={isRemoving}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                      />
                    </div>
                    <div className="md:col-span-3">
                      <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Status</label>
                      <button
                        type="button"
                        onClick={() => handleTopupDraftChange(index, 'isActive', !pack.isActive)}
                        disabled={isRemoving}
                        className={`w-full rounded-lg border px-3 py-2 text-sm font-semibold transition-colors ${
                          pack.isActive
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {pack.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </div>
                    <div className="md:col-span-3 flex md:justify-end">
                      <button
                        type="button"
                        onClick={() => handleRemoveTopupDraft(index)}
                        disabled={topupDrafts.length <= 1 || isRemoving}
                        className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-500 hover:bg-rose-100 disabled:opacity-50"
                      >
                        {isRemoving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        {isRemoving ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  </div>
                    );
                  })()}
                </div>
              ))}

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={handleSaveTopups}
                  disabled={isSavingTopups || isTopupsLoading}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white ${
                    isSavingTopups ? 'bg-blue-500 cursor-wait' : 'bg-blue-600 hover:bg-blue-700'
                  }`}
                >
                  {isSavingTopups ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {isSavingTopups ? 'Saving...' : 'Save Top Ups'}
                </button>
                <button
                  type="button"
                  onClick={handleResetTopups}
                  disabled={isSavingTopups || isTopupsLoading}
                  className="inline-flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2 text-sm font-semibold text-rose-500 hover:bg-rose-100 disabled:opacity-60"
                >
                  <RefreshCw className="h-4 w-4" />
                  Reset
                </button>
              </div>
            </div>
          </div>
        ) : activeTab === 'Histroy' ? (
          <div className="sa-panel bg-white rounded-[20px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] border border-slate-200 overflow-hidden">
            <div className="flex items-center justify-between p-6 border-b border-slate-100">
              <div>
                <h2 className="text-xl font-bold text-slate-900">Histroy Notifications</h2>
                <p className="text-sm text-slate-500 mt-1">See who generated images and when.</p>
              </div>
              <button
                type="button"
                onClick={fetchData}
                disabled={isLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>

            <div className="p-6">
              {isLoading ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((item) => (
                    <div key={`history-skeleton-${item}`} className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/40 p-4 animate-pulse">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className="h-9 w-9 rounded-full bg-slate-200" />
                          <div className="space-y-2">
                            <div className="h-3 w-36 rounded bg-slate-200" />
                            <div className="h-3 w-52 rounded bg-slate-200" />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <div className="h-3 w-20 rounded bg-slate-200" />
                          <div className="h-3 w-16 rounded bg-slate-200 ml-auto" />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : historyEvents.length === 0 ? (
                <div className="py-10 text-center text-slate-500 font-medium">No generation history found yet.</div>
              ) : (
                <div className="space-y-3">
                  {historyEvents.map((entry, index) => {
                    const generatedCount = Number(entry?.generatedCount || 0);
                    const countLabel = generatedCount === 1 ? 'image' : 'images';
                    const eventTime = entry?.eventTime || null;
                    const userId = String(entry?.userId || '').trim();
                    const username = String(entry?.username || 'Unknown User');
                    return (
                      <div
                        key={`${eventTime || 'time'}-${userId || username}-${index}`}
                        className="sa-subpanel rounded-xl border border-slate-200 bg-slate-50/40 p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3"
                      >
                        <div className="flex items-start gap-3">
                          <div className="w-9 h-9 rounded-full bg-blue-50 text-blue-600 border border-blue-100 flex items-center justify-center flex-shrink-0">
                            <Clock className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-slate-800">
                              {username}
                              <span className="ml-2 text-xs text-slate-500 font-medium">{userId || 'unknown-id'}</span>
                            </p>
                            <p className="text-sm text-slate-600 mt-0.5">
                              Generated <span className="font-bold text-slate-800">{generatedCount}</span> {countLabel}
                            </p>
                          </div>
                        </div>
                        <div className="text-left md:text-right">
                          <p className="text-[13px] font-medium text-slate-700">{formatDate(eventTime, '-')}</p>
                          <p className="text-[11px] font-semibold tracking-wide text-slate-500 mt-0.5">{formatTime(eventTime, '-')}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : (
          currentTabContent
        )}
      </main>

      {connectApiGuide && (
        <div
          className="fixed inset-0 z-[72] bg-slate-900/55 backdrop-blur-sm p-4 md:p-8 overflow-y-auto flex items-center justify-center"
          onMouseDown={closeConnectApiModal}
        >
          <div
            className="sa-modal w-full max-w-5xl bg-white rounded-2xl border border-slate-200 shadow-xl overflow-hidden"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h3 className="text-lg font-bold text-slate-900">ConnectAPI</h3>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
                  <span>Integration guide for</span>
                  <span className="font-semibold text-slate-700">{connectApiGuide.projectName}</span>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-full-guide', connectApiGuide.fullGuideText)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                    title="Copy full guide"
                    aria-label="Copy full guide"
                  >
                    <Clipboard className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[11px] text-slate-500">
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-full-guide` ? 'Full guide copied' : 'Copy full'}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      handleDownloadProjectApiGuide(
                        connectApiGuide.projectId,
                        connectApiGuide.projectName,
                        connectApiGuide.fullGuideText
                      )
                    }
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                    title="Download full guide (.txt)"
                    aria-label="Download full guide text file"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  <span className="text-[11px] text-slate-500">
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-full-guide-download` ? 'Downloaded' : 'Download .txt'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={closeConnectApiModal}
                className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-50"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4 max-h-[80vh] overflow-y-auto">
              {!connectApiGuide.hasApi ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                  API key not generated yet. Generate key first, then share this guide with project owner.
                </div>
              ) : null}
              {connectApiLoadError ? (
                <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                  {connectApiLoadError}
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Base URL</p>
                  <p className="mt-1 font-mono text-xs text-slate-800 break-all">{connectApiGuide.baseUrl}</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-base-url', connectApiGuide.baseUrl)}
                    className="mt-2 inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-base-url` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Generate Endpoint</p>
                  <p className="mt-1 font-mono text-xs text-slate-800 break-all">{connectApiGuide.generatePath}</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-generate-path', connectApiGuide.generatePath)}
                    className="mt-2 inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-generate-path` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Analyze Endpoint</p>
                  <p className="mt-1 font-mono text-xs text-slate-800 break-all">{connectApiGuide.analyzePath}</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-analyze-path', connectApiGuide.analyzePath)}
                    className="mt-2 inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-analyze-path` ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Authentication Header</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-header-name', 'x-project-api-key')}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-header-name` ? 'Copied' : 'Copy Header'}
                  </button>
                </div>
                <p className="mt-2 text-xs text-slate-600">Required header: <span className="font-mono text-slate-800">x-project-api-key</span></p>
                <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[11px] text-slate-500">API Key</p>
                  <p className="mt-1 font-mono text-xs text-slate-800 break-all">
                    {connectApiLoadingKey ? 'Loading key...' : (connectApiGuide.apiKey || 'YOUR_PROJECT_API_KEY')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-api-key', connectApiGuide.apiKey || 'YOUR_PROJECT_API_KEY')}
                  className="mt-2 inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                >
                  {connectApiLoadingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clipboard className="h-3.5 w-3.5" />}
                  {copiedProjectApiField === `${connectApiGuide.projectId}:connect-api-key` ? 'Copied' : 'Copy Key'}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-sm font-semibold text-slate-800">POST {connectApiGuide.generatePath}</p>
                  <p className="mt-2 text-xs text-slate-600">Required body rule: at least one of <span className="font-mono">prompt</span> or <span className="font-mono">referenceImage</span>.</p>
                  <p className="mt-2 text-xs text-slate-600">Common variables: <span className="font-mono">productImage</span>, <span className="font-mono">referenceImage</span>, <span className="font-mono">logoImage</span>, <span className="font-mono">skipCaptionGeneration</span>, <span className="font-mono">strictReferenceLock</span>, <span className="font-mono">forceGeminiPlacementOnly</span>, <span className="font-mono">source</span>.</p>
                  <p className="mt-2 text-xs text-slate-600">Prompt-builder fields (prompt auto-build): <span className="font-mono">productName</span>, <span className="font-mono">mainIngredient</span>, <span className="font-mono">visualMood</span>, <span className="font-mono">dynamicElements</span>, <span className="font-mono">colorPalette</span>, <span className="font-mono">backgroundStyle</span>, <span className="font-mono">brandName</span>, <span className="font-mono">ctaText</span>, <span className="font-mono">aspectRatio</span>, <span className="font-mono">lightingFocus</span>, <span className="font-mono">extraNotes</span>.</p>
                  <p className="mt-2 text-xs text-slate-600">Pipeline is fixed in backend: <span className="font-mono">gemini-edit-pipeline</span> (no reference), <span className="font-mono">reference-img-pipeline-1</span> (with reference). Client should not send <span className="font-mono">pipelineName</span>.</p>
                  <p className="mt-2 text-xs text-slate-600">Analyze + Generate can be used together in one flow: first call <span className="font-mono">{connectApiGuide.analyzePath}</span> (Fill with AI style), then call <span className="font-mono">{connectApiGuide.generatePath}</span> using returned fields.</p>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-sm font-semibold text-slate-800">POST {connectApiGuide.analyzePath}</p>
                  <p className="mt-2 text-xs text-slate-600">Required body rule: at least one of <span className="font-mono">productImage</span> or <span className="font-mono">referenceImage</span>.</p>
                  <p className="mt-2 text-xs text-slate-600">Common variables: <span className="font-mono">productImage</span>, <span className="font-mono">referenceImage</span>, <span className="font-mono">provider</span> (<span className="font-mono">gemini</span> or <span className="font-mono">openai</span>), <span className="font-mono">pipelineName</span>.</p>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-800">Easy Contract Summary</p>
                <p className="mt-2 text-xs text-slate-600">
                  Stable analyze keys: <span className="font-mono">productName, mainIngredient, visualMood, dynamicElements, colorPalette, backgroundStyle, brandName, ctaText, aspectRatio, lightingFocus, extraNotes</span>
                </p>
                <p className="mt-1.5 text-xs text-slate-600">
                  Enums: <span className="font-mono">provider=gemini|openai</span>, <span className="font-mono">aspectRatio=1:1|4:5|16:9</span>
                </p>
                <p className="mt-1.5 text-xs text-slate-600">
                  Standard error shape: <span className="font-mono">{'{ code, message, field, details }'}</span>
                </p>
                <p className="mt-1.5 text-xs text-slate-600">
                  Suggested limits: <span className="font-mono">maxFileSize=10MB</span>, <span className="font-mono">maxResolution=4096x4096</span>, <span className="font-mono">MIME=image/png,image/jpeg,image/webp</span>
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold text-slate-800">Pipeline Policy for This Project</p>
                <p className="mt-2 text-xs text-slate-600">
                  Generate default: <span className="font-mono text-slate-800">{connectApiGuide.policy.defaultGeneratePipeline}</span> | Override: <span className="font-mono text-slate-800">{connectApiGuide.policy.allowGenerateOverride ? 'allowed' : 'blocked'}</span>
                </p>
                <p className="mt-1.5 text-xs text-slate-600">
                  Generate allowed: <span className="font-mono text-slate-800">{connectApiGuide.policy.allowedGeneratePipelines.join(', ') || '-'}</span>
                </p>
                <p className="mt-2 text-xs text-slate-600">
                  Analyze default: <span className="font-mono text-slate-800">{connectApiGuide.policy.defaultAnalyzePipeline}</span> | Override: <span className="font-mono text-slate-800">{connectApiGuide.policy.allowAnalyzeOverride ? 'allowed' : 'blocked'}</span>
                </p>
                <p className="mt-1.5 text-xs text-slate-600">
                  Analyze allowed: <span className="font-mono text-slate-800">{connectApiGuide.policy.allowedAnalyzePipelines.join(', ') || '-'}</span>
                </p>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Sample cURL (Generate - No Reference)</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-curl-generate-no-ref', connectApiGuide.generateCurlNoReference)}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-curl-generate-no-ref` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{connectApiGuide.generateCurlNoReference}</pre>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Sample cURL (Generate - With Reference)</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-curl-generate-with-ref', connectApiGuide.generateCurlWithReference)}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-curl-generate-with-ref` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{connectApiGuide.generateCurlWithReference}</pre>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Sample cURL (Analyze)</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-curl-analyze', connectApiGuide.analyzeCurl)}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-curl-analyze` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{connectApiGuide.analyzeCurl}</pre>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Sample JS Fetch (Generate - 2 Cases)</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-js-fetch-generate', connectApiGuide.jsFetchGenerateExample)}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-js-fetch-generate` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{connectApiGuide.jsFetchGenerateExample}</pre>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Sample JS Fetch (Analyze + Generate Flow)</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-js-fetch-combined-flow', connectApiGuide.jsFetchCombinedFlowExample)}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-js-fetch-combined-flow` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{connectApiGuide.jsFetchCombinedFlowExample}</pre>
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-800">Sample Response (Generate)</p>
                    <button
                      type="button"
                      onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-generate-response', toPrettyJson(connectApiGuide.sampleGenerateResponse))}
                      className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      {copiedProjectApiField === `${connectApiGuide.projectId}:connect-generate-response` ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{toPrettyJson(connectApiGuide.sampleGenerateResponse)}</pre>
                </div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-slate-800">Sample Response (Analyze)</p>
                    <button
                      type="button"
                      onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-analyze-response', toPrettyJson(connectApiGuide.sampleAnalyzeResponse))}
                      className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                    >
                      {copiedProjectApiField === `${connectApiGuide.projectId}:connect-analyze-response` ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{toPrettyJson(connectApiGuide.sampleAnalyzeResponse)}</pre>
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-slate-800">Sample Validation Error</p>
                  <button
                    type="button"
                    onClick={() => handleCopyProjectApiText(connectApiGuide.projectId, 'connect-validation-error', toPrettyJson(connectApiGuide.sampleValidationError))}
                    className="inline-flex h-8 items-center rounded-md border border-slate-300 bg-white px-2.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-100"
                  >
                    {copiedProjectApiField === `${connectApiGuide.projectId}:connect-validation-error` ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-700 overflow-auto">{toPrettyJson(connectApiGuide.sampleValidationError)}</pre>
              </div>
            </div>
          </div>
        </div>
      )}

      {deleteDialogUser && (
        <div
          className="sa-delete-overlay fixed inset-0 z-[70] bg-slate-900/55 backdrop-blur-sm p-4 md:p-8 flex items-center justify-center"
          onMouseDown={closeDeleteDialog}
        >
          <div
            className="sa-delete-dialog w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-[0_24px_50px_rgba(2,6,23,0.24)] overflow-hidden"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-6 pt-6">
              <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-500 border border-rose-100 flex items-center justify-center">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="mt-4 text-lg font-extrabold text-slate-900">Delete User Permanently?</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                This will permanently remove <span className="font-semibold text-slate-800">"{deleteDialogUser.username}"</span> from the database.
                This action cannot be undone.
              </p>
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80 px-3 py-2.5">
                <p className="text-xs text-slate-500">Email</p>
                <p className="text-sm font-semibold text-slate-800 truncate">{deleteDialogUser.email || 'No email'}</p>
              </div>
            </div>

            <div className="px-6 py-5 mt-6 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                onClick={closeDeleteDialog}
                disabled={Boolean(deletingUserId)}
                className="sa-ghost-btn px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteUser}
                disabled={Boolean(deletingUserId)}
                className="relative overflow-hidden inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-80"
              >
                {Boolean(deletingUserId) && (
                  <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-rose-400/10 via-white/25 to-rose-400/10" />
                )}
                <span className="relative z-10 inline-flex items-center gap-2">
                  {Boolean(deletingUserId) ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      Delete Permanently
                    </>
                  )}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteProjectDialog && (
        <div
          className="sa-delete-overlay fixed inset-0 z-[70] bg-slate-900/55 backdrop-blur-sm p-4 md:p-8 flex items-center justify-center"
          onMouseDown={closeProjectDeleteDialog}
        >
          <div
            className="sa-delete-dialog w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-[0_24px_50px_rgba(2,6,23,0.24)] overflow-hidden"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="px-6 pt-6">
              <div className="w-12 h-12 rounded-xl bg-rose-50 text-rose-500 border border-rose-100 flex items-center justify-center">
                <Trash2 className="w-6 h-6" />
              </div>
              <h3 className="mt-4 text-lg font-extrabold text-slate-900">Delete Project?</h3>
              <p className="mt-2 text-sm text-slate-600 leading-relaxed">
                You are about to delete <span className="font-semibold text-slate-800">"{deleteProjectDialog.name}"</span>.
                This will also remove its API key and related data permanently.
              </p>
              <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50/80 px-3 py-2.5">
                <p className="text-xs text-rose-600 font-semibold uppercase tracking-wide">Warning</p>
                <p className="text-sm font-medium text-rose-700 mt-0.5">This action cannot be undone.</p>
              </div>
            </div>

            <div className="px-6 py-5 mt-6 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                onClick={closeProjectDeleteDialog}
                disabled={Boolean(projectApiAction.deletingProject)}
                className="sa-ghost-btn px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                onClick={confirmDeleteProject}
                disabled={Boolean(projectApiAction.deletingProject)}
                className="relative overflow-hidden inline-flex items-center gap-2 rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700 disabled:opacity-80"
              >
                {Boolean(projectApiAction.deletingProject) && (
                  <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-rose-400/10 via-white/25 to-rose-400/10" />
                )}
                <span className="relative z-10 inline-flex items-center gap-2">
                  {Boolean(projectApiAction.deletingProject) ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 className="w-4 h-4" />
                      Delete Project
                    </>
                  )}
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      {deletingUserId && (
        <div className="fixed bottom-6 right-6 z-[75]">
          <div className="rounded-xl border border-rose-100 bg-white/95 backdrop-blur-sm shadow-[0_12px_30px_rgba(244,63,94,0.2)] px-4 py-3 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-rose-50 text-rose-600 border border-rose-100 flex items-center justify-center">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
            <div>
              <p className="text-[13px] font-bold text-slate-900">Deleting account...</p>
              <p className="text-[11px] text-slate-500">Please wait a moment</p>
            </div>
          </div>
        </div>
      )}

      {isCreateProjectModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm p-4 md:p-8 overflow-y-auto flex items-center justify-center"
          onMouseDown={closeCreateProjectModal}
        >
          <div
            className="sa-modal w-full max-w-xl bg-white rounded-2xl border border-slate-200 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Create Project</h3>
                <p className="text-sm text-slate-500 mt-1">Create a project and use it to generate API keys for external integrations.</p>
              </div>
              <button
                type="button"
                onClick={closeCreateProjectModal}
                disabled={projectApiAction.creatingProject}
                className="rounded-lg border border-slate-200 bg-white p-2 text-slate-500 hover:text-slate-700 hover:bg-slate-50 disabled:opacity-60"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Project Name</label>
                <input
                  value={manualProjectForm.name}
                  onChange={(e) => setManualProjectForm((prev) => ({ ...prev, name: e.target.value }))}
                  placeholder="My External Client Project"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1 uppercase tracking-wide">Description (Optional)</label>
                <input
                  value={manualProjectForm.description}
                  onChange={(e) => setManualProjectForm((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Used for partner integrations"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="px-6 py-5 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={closeCreateProjectModal}
                disabled={projectApiAction.creatingProject}
                className="sa-ghost-btn px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50 disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={projectApiAction.creatingProject}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
              >
                {projectApiAction.creatingProject ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {projectApiAction.creatingProject ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isUserModalOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm p-4 md:p-8 overflow-y-auto flex items-center justify-center"
          onMouseDown={closeUserModal}
        >
          <div
            className="sa-modal w-full max-w-2xl bg-white rounded-2xl border border-slate-200 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">{editingUser ? 'Edit User' : 'Add New User'}</h3>
              <button
                onClick={closeUserModal}
                className="w-8 h-8 rounded-md border border-slate-200 text-slate-500 hover:bg-slate-50 flex items-center justify-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Username</label>
                <input
                  value={userForm.username}
                  onChange={(e) => handleFormChange('username', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  placeholder="username"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Email</label>
                <input
                  value={userForm.email}
                  onChange={(e) => handleFormChange('email', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  placeholder="user@example.com"
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  {editingUser ? 'New Password (Optional)' : 'Password'}
                </label>
                <input
                  type="password"
                  value={userForm.password}
                  onChange={(e) => handleFormChange('password', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  placeholder={editingUser ? 'Leave blank to keep current' : 'Minimum 6 characters'}
                />
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Role</label>
                <select
                  value={userForm.role}
                  onChange={(e) => handleFormChange('role', e.target.value)}
                  disabled={Boolean(editingUser?.is_super_admin)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-slate-100"
                >
                  {ROLE_OPTIONS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Plan</label>
                <select
                  value={userForm.planTier}
                  onChange={(e) => handleFormChange('planTier', e.target.value)}
                  disabled={Boolean(editingUser?.is_super_admin)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40 disabled:bg-slate-100"
                >
                  {(plans.length ? plans : PLAN_OPTIONS).map((item) => (
                    <option key={item.tier || item.value} value={item.tier || item.value}>
                      {item.name || item.label || planNameMap[item.tier || item.value]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">Credits</label>
                <input
                  type="number"
                  min="0"
                  value={userForm.credits}
                  onChange={(e) => handleFormChange('credits', e.target.value)}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                  placeholder="0"
                />
              </div>

              <div className="md:col-span-2">
                <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={Boolean(userForm.isActive)}
                    disabled={Boolean(editingUser?.is_super_admin)}
                    onChange={(e) => handleFormChange('isActive', e.target.checked)}
                    className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  Account Active
                </label>
                {editingUser?.is_super_admin && (
                  <p className="text-xs text-slate-500 mt-1">Super admin remains active with fixed role and plan.</p>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 flex items-center justify-end gap-3">
              <button
                onClick={closeUserModal}
                className="sa-ghost-btn px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveUser}
                disabled={isSavingUser}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60"
              >
                {isSavingUser ? 'Saving...' : editingUser ? 'Save Changes' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
