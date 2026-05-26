const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { OpenAI, toFile } = require('openai');
const axios = require('axios');
const sharp = require('sharp');
const { Blob } = require('buffer');
const { Pool } = require('pg');
const { Telegraf, Markup } = require('telegraf');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Stripe = require('stripe');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildMainPrompt } = require('../shared/promptBuilder.cjs');
const {
  MANUAL_PRESET_VALUES,
  VIDEO_PRESET_MODES,
  resolveFinalPreset,
} = require('./videoPresetResolver');
const { buildMotionPlanFromGeminiAnalysis } = require('./videoMotionPlan');
let nodemailer = null;
try {
  // Optional at runtime until dependency is installed.
  nodemailer = require('nodemailer');
} catch (error) {
  nodemailer = null;
}

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const STATIC_DIR_CANDIDATES = [
  process.env.STATIC_DIR ? path.resolve(__dirname, '..', process.env.STATIC_DIR) : null,
  path.resolve(__dirname, '..', 'public'),
  path.resolve(__dirname, '..', 'dist'),
  path.resolve(__dirname, '..', 'client', 'dist'),
].filter(Boolean);
const STATIC_DIR = STATIC_DIR_CANDIDATES.find((dirPath) => fs.existsSync(path.join(dirPath, 'index.html'))) || '';
const STATIC_INDEX_PATH = STATIC_DIR ? path.join(STATIC_DIR, 'index.html') : '';
const HAS_STATIC_CLIENT = Boolean(STATIC_INDEX_PATH);
const VIDEO_OUTPUT_DIR = path.resolve(__dirname, '..', 'generated-videos');
const REMOTION_RENDER_SCRIPT_PATH = path.resolve(__dirname, 'remotion', 'render-video.mjs');
const VIDEO_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;
const VIDEO_OUTPUT_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const VIDEO_JOB_PRUNE_AGE_MS = 6 * 60 * 60 * 1000;
const VIDEO_JOB_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const VIDEO_POLLABLE_STATUS = new Set(['queued', 'rendering', 'completed', 'failed']);
const videoRenderJobs = new Map();
let videoCleanupIntervalHandle = null;
let videoJobPruneIntervalHandle = null;
const IS_VERCEL_RUNTIME = String(process.env.VERCEL || '').trim() === '1';
const IS_SERVERLESS_RUNTIME =
  IS_VERCEL_RUNTIME ||
  Boolean(String(process.env.AWS_LAMBDA_FUNCTION_NAME || '').trim()) ||
  String(process.env.NODE_ENV || '').trim().toLowerCase() === 'serverless';
const PAYMENT_WEBHOOK_PATHS = new Set(['/webhook/payment', '/api/webhook/payment']);
const normalizeRoutePath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '/';
  const withoutQuery = raw.split('?')[0].trim();
  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
};
const isPaymentWebhookRequestPath = (req) =>
  PAYMENT_WEBHOOK_PATHS.has(normalizeRoutePath(req?.originalUrl || req?.url || ''));
const normalizeWebhookPath = (pathValue) => {
  const defaultPath = '/webhook';
  const normalizedRaw = normalizeRoutePath(pathValue || defaultPath);
  const withoutDuplicateApiPrefix = normalizedRaw.replace(/^\/api(?=\/)/i, '');
  if (!IS_SERVERLESS_RUNTIME) {
    return withoutDuplicateApiPrefix || defaultPath;
  }
  return normalizeRoutePath(`/api${withoutDuplicateApiPrefix || defaultPath}`);
};

app.use(cors());
app.use(express.json({
  limit: '50mb',
  verify: (req, res, buf) => {
    if (isPaymentWebhookRequestPath(req)) {
      req.rawBody = buf;
    }
  },
}));

try { fs.mkdirSync(VIDEO_OUTPUT_DIR, { recursive: true }); } catch (_) {}
app.use('/generated-videos', express.static(VIDEO_OUTPUT_DIR));

if (HAS_STATIC_CLIENT) {
  app.use(express.static(STATIC_DIR));
}

const OPENAI_REQUEST_TIMEOUT_MS = Number.isFinite(Number(process.env.TELEGRAM_OPENAI_TIMEOUT_MS))
  ? Math.max(10000, Math.floor(Number(process.env.TELEGRAM_OPENAI_TIMEOUT_MS)))
  : 90000;

let openai = null;
const refreshOpenAiRuntimeFromEnv = () => {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim() || 'missing-openai-key';
  const baseURL = String(process.env.OPENAI_BASE_URL || process.env.OPENAI_TEXT_URL || '').trim();
  openai = new OpenAI({
    apiKey,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
    ...(baseURL ? { baseURL } : {}),
  });
};
refreshOpenAiRuntimeFromEnv();

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const PG_SSL_ENABLED = String(process.env.PGSSLMODE || (DATABASE_URL ? 'true' : 'false')).toLowerCase() === 'true';
const DB_AUTO_DDL = String(process.env.DB_AUTO_DDL || 'true').toLowerCase() !== 'false';
const DB_BOOTSTRAP_ON_START = String(process.env.DB_BOOTSTRAP_ON_START || 'true').toLowerCase() !== 'false';

const pool = new Pool(
  DATABASE_URL
    ? {
      connectionString: DATABASE_URL,
      ssl: PG_SSL_ENABLED ? { rejectUnauthorized: false } : false,
    }
    : {
      host: process.env.PGHOST || '127.0.0.1',
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER || 'postgres',
      password: process.env.PGPASSWORD || '',
      database: process.env.PGDATABASE || 'postgres',
      ssl: PG_SSL_ENABLED ? { rejectUnauthorized: false } : false,
    }
);

pool.on('error', (error) => {
  console.error('Postgres pool error:', error.message);
});

const DB_SCHEMA_FILE_CANDIDATES = [
  path.resolve(__dirname, '..', 'supabase', 'migrations', '20260414000100_init_schema.sql'),
  path.resolve(__dirname, '..', 'schema.sql'),
  path.resolve(__dirname, 'supabase', 'migrations', '20260414000100_init_schema.sql'),
  path.resolve(__dirname, 'schema.sql'),
  path.resolve(process.cwd(), 'supabase', 'migrations', '20260414000100_init_schema.sql'),
  path.resolve(process.cwd(), 'schema.sql'),
];

const findBootstrapSchemaFilePath = () =>
  DB_SCHEMA_FILE_CANDIDATES.find((filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      return false;
    }
  }) || '';

const getMissingCoreDbRelations = async () => {
  const result = await pool.query(
    `
      SELECT
        to_regclass('public.users') AS users_table,
        to_regclass('public.plan_settings') AS plan_settings_table
    `
  );
  const row = result.rows[0] || {};
  const missing = [];
  if (!row.users_table) missing.push('users');
  if (!row.plan_settings_table) missing.push('plan_settings');
  return missing;
};

const ensureBootstrapSchemaOnStart = async () => {
  if (!DB_BOOTSTRAP_ON_START) return;
  const missingBeforeBootstrap = await getMissingCoreDbRelations();
  if (!missingBeforeBootstrap.length) return;

  const schemaPath = findBootstrapSchemaFilePath();
  if (!schemaPath) {
    throw new Error(
      `Database schema is missing (${missingBeforeBootstrap.join(', ')}) and no bootstrap schema file was found`
    );
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  if (!String(schemaSql || '').trim()) {
    throw new Error(`Bootstrap schema file is empty: ${schemaPath}`);
  }

  console.warn(
    `Missing DB relations (${missingBeforeBootstrap.join(', ')}). Applying bootstrap schema from ${schemaPath}.`
  );
  await pool.query(schemaSql);

  const missingAfterBootstrap = await getMissingCoreDbRelations();
  if (missingAfterBootstrap.length) {
    throw new Error(
      `Bootstrap schema applied but required relations are still missing: ${missingAfterBootstrap.join(', ')}`
    );
  }
  console.log('Database bootstrap schema applied successfully.');
};

const AUTH_JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const AUTH_JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USERNAME || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || 'admin';
const DEFAULT_SADMIN_USERNAME = process.env.DEFAULT_SADMIN_USERNAME || 'sadmin';
const DEFAULT_SADMIN_PASSWORD = process.env.DEFAULT_SADMIN_PASSWORD || 'sadmin';
const ALLOW_DEV_AUTH_BYPASS = String(process.env.ALLOW_DEV_AUTH_BYPASS || '').toLowerCase() === 'true';
const DEV_AUTH_BYPASS_TOKEN = String(process.env.DEV_AUTH_BYPASS_TOKEN || 'dev-auth-bypass').trim();
const DEV_AUTH_BYPASS_PASSWORD = String(process.env.DEV_AUTH_BYPASS_PASSWORD || 'admin').trim();
const INTERNAL_API_KEY = String(process.env.INTERNAL_API_KEY || '').trim();
const PROJECT_API_KEY_PREFIX = 'adr_';
const PROJECT_API_EXTERNAL_GENERATE_PATH = '/api/external/generate';
const PROJECT_API_EXTERNAL_ANALYZE_PATH = '/api/external/analyze';
const PIPELINE_NAME_GEMINI_EDIT = 'gemini-edit-pipeline';
const PIPELINE_NAME_GEMINI_REFERENCE_GUIDED = 'reference-img-pipeline-1';
const PIPELINE_NAME_GEMINI_REFERENCE_GUIDED_LEGACY = 'gemini-reference-guided-pipeline';
const PIPELINE_NAME_OPENAI_IMAGE = 'openai-image-pipeline';
const PIPELINE_NAME_OPENAI_ANALYZE = 'openai-analyze-pipeline';
const PIPELINE_NAME_GEMINI_CREATIVE_PLAN = 'gemini-edit-pipeline';
const PROJECT_API_GENERATE_PIPELINES = Object.freeze([
  PIPELINE_NAME_GEMINI_EDIT,
  PIPELINE_NAME_GEMINI_REFERENCE_GUIDED,
  PIPELINE_NAME_OPENAI_IMAGE,
]);
const PROJECT_API_ANALYZE_PIPELINES = Object.freeze([
  PIPELINE_NAME_GEMINI_EDIT,
  PIPELINE_NAME_OPENAI_ANALYZE,
]);
const PROJECT_API_RUNTIME_SETTINGS_SINGLETON_ID = 1;
const DEFAULT_PROJECT_API_RUNTIME_SETTINGS = Object.freeze({
  externalGenerateEnabled: true,
  externalAnalyzeEnabled: true,
});
const DEFAULT_PROJECT_API_PIPELINE_POLICY = Object.freeze({
  defaultGeneratePipeline: PIPELINE_NAME_GEMINI_EDIT,
  allowedGeneratePipelines: PROJECT_API_GENERATE_PIPELINES,
  allowGenerateOverride: true,
  defaultAnalyzePipeline: PIPELINE_NAME_GEMINI_EDIT,
  allowedAnalyzePipelines: PROJECT_API_ANALYZE_PIPELINES,
  allowAnalyzeOverride: true,
});
const PROJECT_API_LOG_RETENTION_DAYS = 30;
const PROJECT_API_LOG_RETENTION_INTERVAL_SQL = `${PROJECT_API_LOG_RETENTION_DAYS} days`;
const PROJECT_API_LOG_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const PROJECT_API_LOG_STRING_LIMIT = 320;
const PROJECT_API_LOG_MAX_DEPTH = 4;
const PROJECT_API_LOG_MAX_ARRAY_ITEMS = 10;
const PROJECT_API_LOG_MAX_OBJECT_KEYS = 30;
const PROJECT_API_LOG_LEVELS = new Set(['info', 'error']);
const PROJECT_API_LOG_REQUEST_OMIT_KEYS = new Set(['productimage', 'referenceimage', 'logoimage']);
const PROJECT_API_LOG_RESPONSE_OMIT_KEYS = new Set([
  'imageurl',
  'recreatedbackgroundimageurl',
  'productimage',
  'referenceimage',
  'logoimage',
]);
const PROJECT_API_LOG_SENSITIVE_HEADER_KEYS = new Set([
  'xprojectapikey',
  'authorization',
  'cookie',
  'setcookie',
  'proxyauthorization',
]);
let projectApiLogCleanupLastAt = 0;
let projectApiLogCleanupRunning = false;
const PROJECT_API_KEY_ENCRYPTION_SECRET_RAW = String(
  process.env.PROJECT_API_KEY_ENCRYPTION_SECRET ||
  INTERNAL_API_KEY ||
  AUTH_JWT_SECRET ||
  'adready-project-api-secret-change-me'
).trim();
const PROJECT_API_KEY_ENCRYPTION_KEY = crypto
  .createHash('sha256')
  .update(PROJECT_API_KEY_ENCRYPTION_SECRET_RAW || 'adready-project-api-secret-change-me')
  .digest();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let activeStripeSecretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
let activeStripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
let stripe = activeStripeSecretKey ? new Stripe(activeStripeSecretKey) : null;
const refreshStripeRuntimeFromEnv = () => {
  activeStripeSecretKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  activeStripeWebhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  stripe = activeStripeSecretKey ? new Stripe(activeStripeSecretKey) : null;
};
const TELEGRAM_TOPUP_CREDITS = Number.isFinite(Number(process.env.TELEGRAM_TOPUP_CREDITS))
  ? Math.max(1, Math.floor(Number(process.env.TELEGRAM_TOPUP_CREDITS)))
  : 50;
const TELEGRAM_TOPUP_PRICE_USD = Number.isFinite(Number(process.env.TELEGRAM_TOPUP_PRICE_USD))
  ? Math.max(1, Number(process.env.TELEGRAM_TOPUP_PRICE_USD))
  : 15;
const TELEGRAM_TOPUP_PACK_OPTIONS = (() => {
  const configured = String(process.env.TELEGRAM_TOPUP_PACKS || '25,50,100')
    .split(',')
    .map((value) => Math.floor(Number(value)))
    .filter((value) => Number.isFinite(value) && value > 0);
  const unique = Array.from(new Set(configured));
  if (!unique.length) {
    unique.push(25, 50, 100);
  }
  if (!unique.includes(TELEGRAM_TOPUP_CREDITS)) {
    unique.push(TELEGRAM_TOPUP_CREDITS);
  }
  return unique.sort((a, b) => a - b);
})();
const TELEGRAM_TOPUP_UNIT_PRICE_USD = TELEGRAM_TOPUP_PRICE_USD / Math.max(1, TELEGRAM_TOPUP_CREDITS);
const DEFAULT_TOPUP_PACK_DEFINITIONS = TELEGRAM_TOPUP_PACK_OPTIONS.map((credits, index) => ({
  credits,
  priceUsd: Number((TELEGRAM_TOPUP_UNIT_PRICE_USD * credits).toFixed(2)),
  isActive: true,
  sortOrder: index + 1,
}));
let TOPUP_PACK_DEFINITIONS = JSON.parse(JSON.stringify(DEFAULT_TOPUP_PACK_DEFINITIONS));
const TELEGRAM_GENERATION_VARIANT_COUNT = Number.isFinite(Number(process.env.TELEGRAM_GENERATION_VARIANT_COUNT))
  ? Math.max(1, Math.floor(Number(process.env.TELEGRAM_GENERATION_VARIANT_COUNT)))
  : 2;
const TELEGRAM_USE_WEB_BRAND_TEXT_PIPELINE =
  String(process.env.TELEGRAM_USE_WEB_BRAND_TEXT_PIPELINE || 'true').toLowerCase() !== 'false';
const TELEGRAM_JOB_POLL_INTERVAL_MS = Number.isFinite(Number(process.env.TELEGRAM_JOB_POLL_INTERVAL_MS))
  ? Math.max(500, Math.floor(Number(process.env.TELEGRAM_JOB_POLL_INTERVAL_MS)))
  : 2500;
const TELEGRAM_IMAGE_FETCH_TIMEOUT_MS = Number.isFinite(Number(process.env.TELEGRAM_IMAGE_FETCH_TIMEOUT_MS))
  ? Math.max(5000, Math.floor(Number(process.env.TELEGRAM_IMAGE_FETCH_TIMEOUT_MS)))
  : 30000;
const TELEGRAM_JOB_MAX_RUNTIME_MS = Number.isFinite(Number(process.env.TELEGRAM_JOB_MAX_RUNTIME_MS))
  ? Math.max(60000, Math.floor(Number(process.env.TELEGRAM_JOB_MAX_RUNTIME_MS)))
  : 240000;
const TELEGRAM_STALE_JOB_GRACE_MS = Number.isFinite(Number(process.env.TELEGRAM_STALE_JOB_GRACE_MS))
  ? Math.max(60000, Math.floor(Number(process.env.TELEGRAM_STALE_JOB_GRACE_MS)))
  : 120000;
const EMAIL_VERIFICATION_CODE_LENGTH = Number.isFinite(Number(process.env.EMAIL_VERIFICATION_CODE_LENGTH))
  ? Math.max(4, Math.min(8, Math.floor(Number(process.env.EMAIL_VERIFICATION_CODE_LENGTH))))
  : 6;
const EMAIL_VERIFICATION_EXPIRY_MINUTES = Number.isFinite(Number(process.env.EMAIL_VERIFICATION_EXPIRY_MINUTES))
  ? Math.max(1, Math.min(60, Math.floor(Number(process.env.EMAIL_VERIFICATION_EXPIRY_MINUTES))))
  : 10;
const EMAIL_VERIFICATION_MAX_ATTEMPTS = Number.isFinite(Number(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS))
  ? Math.max(1, Math.min(10, Math.floor(Number(process.env.EMAIL_VERIFICATION_MAX_ATTEMPTS))))
  : 5;
let smtpHost = '';
let smtpPort = 587;
let smtpSecure = false;
let smtpUser = '';
let smtpPass = '';
let smtpFrom = '';
let smtpReady = false;
let smtpTransport = null;
const EMAIL_LOGO_CID = 'royalbengalai-logo';
const EMAIL_LOGO_PATH_CANDIDATES = [
  String(process.env.EMAIL_LOGO_PATH || '').trim(),
  path.resolve(__dirname, 'assets', 'email', 'royal-bengal-ai-logo.png'),
  path.resolve(__dirname, 'assets', 'email', 'royal-bengal-ai-logo.png.png'),
  path.resolve(__dirname, 'assets', 'email', 'royal-bengal-ai-logo.jpg'),
  path.resolve(__dirname, 'assets', 'email', 'royal-bengal-ai-logo.jpeg'),
  path.resolve(__dirname, 'assets', 'email', 'royal-bengal-ai-logo.webp'),
  path.resolve(__dirname, 'assets', 'email', 'royal-bengal-ai-logo.svg'),
].filter(Boolean);
const EMAIL_LOGO_PATH = EMAIL_LOGO_PATH_CANDIDATES.find((filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
}) || '';

const refreshSmtpRuntimeFromEnv = ({ logIfMissing = false } = {}) => {
  smtpHost = String(process.env.SMTP_HOST || '').trim();
  const smtpPortRaw = Number(process.env.SMTP_PORT);
  smtpSecure = String(process.env.SMTP_SECURE || '').trim().toLowerCase() === 'true';
  smtpPort = Number.isFinite(smtpPortRaw) && smtpPortRaw > 0
    ? Math.floor(smtpPortRaw)
    : (smtpSecure ? 465 : 587);
  smtpUser = String(process.env.SMTP_USER || '').trim();
  smtpPass = String(process.env.SMTP_PASS || '').trim();
  smtpFrom = String(process.env.SMTP_FROM || process.env.EMAIL_FROM || smtpUser || '').trim();

  smtpReady = Boolean(
    nodemailer &&
    smtpHost &&
    smtpPort > 0 &&
    smtpUser &&
    smtpPass &&
    smtpFrom
  );

  smtpTransport = smtpReady
    ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    })
    : null;

  if (!smtpReady && logIfMissing) {
    const missingSmtpParts = [];
    if (!nodemailer) missingSmtpParts.push('nodemailer package');
    if (!smtpHost) missingSmtpParts.push('SMTP_HOST');
    if (!(smtpPort > 0)) missingSmtpParts.push('SMTP_PORT');
    if (!smtpUser) missingSmtpParts.push('SMTP_USER');
    if (!smtpPass) missingSmtpParts.push('SMTP_PASS');
    if (!smtpFrom) missingSmtpParts.push('SMTP_FROM/EMAIL_FROM');
    console.warn(
      `Email verification SMTP is not fully configured (${missingSmtpParts.join(', ')}). ` +
      'Telegram email verification will not work.'
    );
  }
};
refreshSmtpRuntimeFromEnv({ logIfMissing: true });

const generateEmailVerificationCode = () => {
  const max = 10 ** EMAIL_VERIFICATION_CODE_LENGTH;
  const value = crypto.randomInt(0, max);
  return String(value).padStart(EMAIL_VERIFICATION_CODE_LENGTH, '0');
};

const hashEmailVerificationCode = ({ code, email, userId }) =>
  crypto
    .createHash('sha256')
    .update(`${String(code || '')}|${String(email || '').toLowerCase()}|${String(userId || '')}|${AUTH_JWT_SECRET}`)
    .digest('hex');

const sendEmailVerificationCode = async ({ email, code }) => {
  if (!smtpReady || !smtpTransport) {
    throw new Error('Email SMTP is not configured');
  }
  const hasEmbeddedLogo = Boolean(EMAIL_LOGO_PATH);
  const logoBlock = hasEmbeddedLogo
    ? `<img src="cid:${EMAIL_LOGO_CID}" alt="Royal Bengal AI" style="display:block;width:84px;height:84px;object-fit:contain;margin:0 0 12px;" />`
    : '<div style="font-size:22px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;margin:0 0 12px;color:#111827;">Royal Bengal AI</div>';
  const subject = `Your AdReady code is ${code}`;
  const text = [
    'Royal Bengal AI',
    'AdReady',
    '',
    `Your AdReady verification code is ${code}.`,
    '',
    `This code expires in ${EMAIL_VERIFICATION_EXPIRY_MINUTES} minutes.`,
    'If you did not request this, you can safely ignore this email.',
    '',
    'Best,',
    'AdReady Team at Royal Bengal AI',
  ].join('\n');
  const html = `
    <div style="margin:0;padding:24px;background:#f5f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0f172a;">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;padding:36px 32px;box-sizing:border-box;">
        ${logoBlock}
        <div style="font-size:30px;line-height:1.15;font-weight:700;letter-spacing:-0.02em;margin:0;color:#111827;">Royal Bengal AI</div>
        <div style="font-size:16px;line-height:1.4;font-weight:600;color:#6b7280;margin:8px 0 24px;">AdReady</div>
        <p style="margin:0 0 18px;font-size:22px;line-height:1.35;font-weight:600;color:#111827;">Your temporary verification code</p>
        <p style="margin:0 0 14px;font-size:16px;line-height:1.6;color:#374151;">Enter this code to continue:</p>
        <div style="margin:0 0 18px;padding:18px 22px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:12px;font-size:34px;line-height:1.1;font-weight:700;letter-spacing:6px;color:#111827;text-align:left;">${code}</div>
        <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b5563;">This code expires in ${EMAIL_VERIFICATION_EXPIRY_MINUTES} minutes.</p>
        <p style="margin:0 0 26px;font-size:15px;line-height:1.6;color:#4b5563;">If you did not request this, you can safely ignore this email.</p>
        <p style="margin:0;color:#6b7280;font-size:14px;line-height:1.6;">Best,<br>AdReady Team at Royal Bengal AI</p>
      </div>
    </div>
  `;
  const attachments = hasEmbeddedLogo
    ? [
      {
        filename: path.basename(EMAIL_LOGO_PATH),
        path: EMAIL_LOGO_PATH,
        cid: EMAIL_LOGO_CID,
      },
    ]
    : [];
  await smtpTransport.sendMail({
    from: smtpFrom,
    to: String(email || '').trim(),
    subject,
    text,
    html,
    ...(attachments.length ? { attachments } : {}),
  });
};

const DEFAULT_PLAN_DEFINITIONS = {
  free: {
    tier: 'free',
    name: 'Free',
    priceUsdMonthly: 0,
    monthlyCredits: 5,
  },
  basic: {
    tier: 'basic',
    name: 'Basic',
    priceUsdMonthly: 30,
    monthlyCredits: 100,
  },
  pro: {
    tier: 'pro',
    name: 'Pro',
    priceUsdMonthly: 50,
    monthlyCredits: 250,
  },
};

let PLAN_DEFINITIONS = JSON.parse(JSON.stringify(DEFAULT_PLAN_DEFINITIONS));
const PLAN_ORDER = ['free', 'basic', 'pro'];
const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');
const getRequestOrigin = (req) => {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').trim();
  if (!host) {
    return '';
  }
  return `${protocol}://${host}`;
};
const resolveClientBaseUrl = (req) => {
  const configuredBaseUrl = trimTrailingSlash(process.env.CLIENT_BASE_URL || '');
  if (configuredBaseUrl) {
    return configuredBaseUrl;
  }
  return trimTrailingSlash(getRequestOrigin(req));
};
const normalizePlanTier = (value) => {
  const tier = String(value || '').toLowerCase();
  return PLAN_DEFINITIONS[tier] ? tier : 'free';
};
const normalizeTopupPackageDraft = (draft = {}, fallbackSortOrder = 0) => {
  const credits = Math.floor(Number(draft?.credits));
  const priceUsd = Number(draft?.priceUsd);
  const sortOrder = Math.floor(Number(draft?.sortOrder));
  return {
    credits: Number.isFinite(credits) ? credits : 0,
    priceUsd: Number.isFinite(priceUsd) ? Number(priceUsd.toFixed(2)) : 0,
    isActive: draft?.isActive !== false,
    sortOrder: Number.isFinite(sortOrder) ? sortOrder : fallbackSortOrder,
  };
};
const sortTopupPackages = (items = []) =>
  [...items].sort((a, b) => {
    const orderDiff = Number(a?.sortOrder || 0) - Number(b?.sortOrder || 0);
    if (orderDiff !== 0) return orderDiff;
    return Number(a?.credits || 0) - Number(b?.credits || 0);
  });
const getOrderedTopupPackages = () => sortTopupPackages(TOPUP_PACK_DEFINITIONS);
const getActiveTopupPackages = () => getOrderedTopupPackages().filter((item) => item.isActive !== false);
const getDefaultTopupPackageCredits = () => {
  const activeTopups = getActiveTopupPackages();
  if (activeTopups.length) return Math.max(1, Number(activeTopups[0].credits || 1));
  const allTopups = getOrderedTopupPackages();
  if (allTopups.length) return Math.max(1, Number(allTopups[0].credits || 1));
  return TELEGRAM_TOPUP_CREDITS;
};
const findTopupPackageByCredits = (creditsValue) => {
  const credits = Math.floor(Number(creditsValue));
  if (!Number.isFinite(credits) || credits <= 0) return null;
  const exact = getOrderedTopupPackages().find((item) => Number(item.credits) === credits);
  return exact || null;
};
const getPlanConfig = (tier) => PLAN_DEFINITIONS[normalizePlanTier(tier)];
const getOrderedPlanConfigs = () =>
  PLAN_ORDER.map((tier) => {
    const plan = getPlanConfig(tier);
    return {
      tier,
      name: plan.name,
      priceUsdMonthly: Number(plan.priceUsdMonthly || 0),
      monthlyCredits: Number(plan.monthlyCredits || 0),
    };
  });

const hashProjectApiKey = (apiKey) =>
  crypto.createHash('sha256').update(String(apiKey || '')).digest('hex');

const generateProjectApiKey = () =>
  `${PROJECT_API_KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;

const getProjectApiKeyPrefix = (apiKey) => {
  const normalized = String(apiKey || '').trim();
  if (!normalized) return PROJECT_API_KEY_PREFIX;
  return normalized.slice(0, Math.min(8, normalized.length));
};

const getProjectApiKeyLast4 = (apiKey) => {
  const normalized = String(apiKey || '').trim();
  if (!normalized) return '';
  return normalized.slice(-4);
};

const buildProjectApiKeyPreview = ({ keyPrefix, keyLast4 }) =>
  `${String(keyPrefix || PROJECT_API_KEY_PREFIX)}****${String(keyLast4 || '')}`;

const encryptProjectApiKey = (apiKey) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', PROJECT_API_KEY_ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(apiKey || ''), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${authTag.toString('base64url')}.${encrypted.toString('base64url')}`;
};

const decryptProjectApiKey = (ciphertext) => {
  const text = String(ciphertext || '').trim();
  const parts = text.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Unsupported project API key cipher format');
  }
  const iv = Buffer.from(parts[1], 'base64url');
  const authTag = Buffer.from(parts[2], 'base64url');
  const encrypted = Buffer.from(parts[3], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', PROJECT_API_KEY_ENCRYPTION_KEY, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

const mapProjectApiAdminRow = (row) => ({
  projectId: String(row?.project_id || ''),
  projectName: String(row?.project_name || ''),
  projectStatus: row?.project_status ? String(row.project_status) : null,
  ownerUserId: row?.owner_user_id ? String(row.owner_user_id) : null,
  keyPrefix: String(row?.key_prefix || PROJECT_API_KEY_PREFIX),
  keyLast4: String(row?.key_last4 || ''),
  keyPreview: buildProjectApiKeyPreview({
    keyPrefix: row?.key_prefix || PROJECT_API_KEY_PREFIX,
    keyLast4: row?.key_last4 || '',
  }),
  isEnabled: row?.is_enabled !== false,
  createdByUserId: row?.created_by_user_id ? String(row.created_by_user_id) : null,
  rotatedAt: row?.rotated_at || null,
  lastUsedAt: row?.last_used_at || null,
  createdAt: row?.created_at || null,
  updatedAt: row?.updated_at || null,
  sourceType: row?.source_type ? String(row.source_type) : 'manual',
  telegramId: row?.telegram_id ? String(row.telegram_id) : null,
  telegramBotUsername: row?.telegram_bot_username ? String(row.telegram_bot_username) : null,
});

const normalizePipelineToken = (value) => {
  const token = String(value || '').trim().toLowerCase();
  if (!token) {
    return '';
  }
  if (token === PIPELINE_NAME_GEMINI_REFERENCE_GUIDED_LEGACY) {
    return PIPELINE_NAME_GEMINI_REFERENCE_GUIDED;
  }
  return token;
};

const cloneStringList = (values = []) => values.map((item) => String(item || '')).filter(Boolean);

const buildDefaultProjectApiRuntimeSettings = () => ({
  externalGenerateEnabled: DEFAULT_PROJECT_API_RUNTIME_SETTINGS.externalGenerateEnabled !== false,
  externalAnalyzeEnabled: DEFAULT_PROJECT_API_RUNTIME_SETTINGS.externalAnalyzeEnabled !== false,
});

const buildDefaultProjectApiPipelinePolicy = () => ({
  defaultGeneratePipeline: String(DEFAULT_PROJECT_API_PIPELINE_POLICY.defaultGeneratePipeline),
  allowedGeneratePipelines: cloneStringList(DEFAULT_PROJECT_API_PIPELINE_POLICY.allowedGeneratePipelines),
  allowGenerateOverride: DEFAULT_PROJECT_API_PIPELINE_POLICY.allowGenerateOverride !== false,
  defaultAnalyzePipeline: String(DEFAULT_PROJECT_API_PIPELINE_POLICY.defaultAnalyzePipeline),
  allowedAnalyzePipelines: cloneStringList(DEFAULT_PROJECT_API_PIPELINE_POLICY.allowedAnalyzePipelines),
  allowAnalyzeOverride: DEFAULT_PROJECT_API_PIPELINE_POLICY.allowAnalyzeOverride !== false,
});

const sanitizePipelineAllowlist = (rawList, allowedSet, fallbackList, options = {}) => {
  if (!Array.isArray(rawList)) {
    return cloneStringList(fallbackList);
  }
  const normalizedList = rawList.map((value) => normalizePipelineToken(value)).filter(Boolean);
  const deduped = [];
  for (const item of normalizedList) {
    if (!allowedSet.has(item)) continue;
    if (deduped.includes(item)) continue;
    deduped.push(item);
  }
  if (deduped.length > 0) {
    return deduped;
  }
  if (options.allowEmpty === true) {
    return [];
  }
  return cloneStringList(fallbackList);
};

const parseRequestedPipelineAllowlist = (rawList, allowedSet) => {
  if (!Array.isArray(rawList)) {
    return { ok: false, value: [], error: 'must_be_array' };
  }
  const normalized = [];
  for (const item of rawList) {
    const token = normalizePipelineToken(item);
    if (!token) continue;
    if (!allowedSet.has(token)) {
      return { ok: false, value: [], error: 'invalid_pipeline' };
    }
    if (normalized.includes(token)) continue;
    normalized.push(token);
  }
  return { ok: true, value: normalized, error: null };
};

const normalizeProjectApiRuntimeSettingsRow = (row = null) => {
  const fallback = buildDefaultProjectApiRuntimeSettings();
  return {
    externalGenerateEnabled:
      row?.external_generate_enabled === undefined
        ? fallback.externalGenerateEnabled
        : row.external_generate_enabled !== false,
    externalAnalyzeEnabled:
      row?.external_analyze_enabled === undefined
        ? fallback.externalAnalyzeEnabled
        : row.external_analyze_enabled !== false,
    updatedAt: row?.updated_at || null,
  };
};

const normalizeProjectApiPipelinePolicyRow = (row = null) => {
  const fallback = buildDefaultProjectApiPipelinePolicy();
  const allowedGenerateSet = new Set(PROJECT_API_GENERATE_PIPELINES);
  const allowedAnalyzeSet = new Set(PROJECT_API_ANALYZE_PIPELINES);
  const allowedGeneratePipelines = sanitizePipelineAllowlist(
    row?.allowed_generate_pipelines,
    allowedGenerateSet,
    fallback.allowedGeneratePipelines,
    { allowEmpty: Array.isArray(row?.allowed_generate_pipelines) }
  );
  const allowedAnalyzePipelines = sanitizePipelineAllowlist(
    row?.allowed_analyze_pipelines,
    allowedAnalyzeSet,
    fallback.allowedAnalyzePipelines,
    { allowEmpty: Array.isArray(row?.allowed_analyze_pipelines) }
  );

  const requestedDefaultGenerate = normalizePipelineToken(row?.default_generate_pipeline);
  const requestedDefaultAnalyze = normalizePipelineToken(row?.default_analyze_pipeline);
  const defaultGeneratePipeline = allowedGenerateSet.has(requestedDefaultGenerate)
    ? requestedDefaultGenerate
    : fallback.defaultGeneratePipeline;
  const defaultAnalyzePipeline = allowedAnalyzeSet.has(requestedDefaultAnalyze)
    ? requestedDefaultAnalyze
    : fallback.defaultAnalyzePipeline;

  return {
    projectId: row?.project_id ? String(row.project_id) : '',
    defaultGeneratePipeline,
    allowedGeneratePipelines,
    allowGenerateOverride:
      row?.allow_generate_override === undefined
        ? fallback.allowGenerateOverride
        : row.allow_generate_override !== false,
    defaultAnalyzePipeline,
    allowedAnalyzePipelines,
    allowAnalyzeOverride:
      row?.allow_analyze_override === undefined
        ? fallback.allowAnalyzeOverride
        : row.allow_analyze_override !== false,
    createdAt: row?.created_at || null,
    updatedAt: row?.updated_at || null,
  };
};

const toSqlTextArrayLiteral = (values = []) =>
  `ARRAY[${values.map((value) => `'${String(value || '').replace(/'/g, "''")}'`).join(', ')}]::TEXT[]`;

const buildProjectExternalEndpointUrl = (req) => {
  const origin = trimTrailingSlash(getRequestOrigin(req));
  if (!origin) return PROJECT_API_EXTERNAL_GENERATE_PATH;
  return `${origin}${PROJECT_API_EXTERNAL_GENERATE_PATH}`;
};

const buildProjectExternalAnalyzeEndpointUrl = (req) => {
  const origin = trimTrailingSlash(getRequestOrigin(req));
  if (!origin) return PROJECT_API_EXTERNAL_ANALYZE_PATH;
  return `${origin}${PROJECT_API_EXTERNAL_ANALYZE_PATH}`;
};

const getTelegramProjectContext = async (projectIds = []) => {
  const contextByProjectId = {};
  const normalizedProjectIds = Array.isArray(projectIds)
    ? projectIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  let fallbackBotUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').trim();
  try {
    const integrationResult = await pool.query(
      `
        SELECT config
        FROM integration_settings
        WHERE provider = 'telegram'
        LIMIT 1
      `
    );
    const config = integrationResult.rows[0]?.config;
    const dbBotUsername = config && typeof config === 'object'
      ? String(config.bot_username || '').trim()
      : '';
    if (dbBotUsername) {
      fallbackBotUsername = dbBotUsername;
    }
  } catch (error) {
    if (error?.code !== '42P01') {
      throw error;
    }
  }

  if (!normalizedProjectIds.length) {
    return { contextByProjectId, fallbackBotUsername };
  }

  try {
    const telegramAssetRows = await pool.query(
      `
        SELECT
          project_id::text AS project_id,
          NULLIF(TRIM(split_part(storage_key, '/', 2)), '') AS telegram_id,
          COALESCE(NULLIF(TRIM(metadata->>'telegram_bot_username'), ''), NULL) AS telegram_bot_username,
          created_at
        FROM assets
        WHERE project_id = ANY($1::uuid[])
          AND storage_key LIKE 'telegram/%'
        ORDER BY created_at DESC
      `,
      [normalizedProjectIds]
    );

    for (const row of telegramAssetRows.rows) {
      const projectId = String(row?.project_id || '').trim();
      if (!projectId || contextByProjectId[projectId]) continue;
      const telegramId = String(row?.telegram_id || '').trim();
      if (!telegramId) continue;
      const telegramBotUsername = String(row?.telegram_bot_username || '').trim();
      contextByProjectId[projectId] = {
        telegramId,
        telegramBotUsername: telegramBotUsername || fallbackBotUsername || '',
      };
    }
  } catch (error) {
    if (error?.code !== '42P01') {
      throw error;
    }
  }

  return { contextByProjectId, fallbackBotUsername };
};

const CONNECTION_PROVIDER_ORDER = ['telegram', 'stripe', 'openai', 'gemini', 'smtp'];
const CONNECTION_CONFIG_KEYS = {
  telegram: ['bot_username', 'bot_token', 'mode', 'webhook_path', 'public_server_url'],
  stripe: ['publishable_key', 'secret_key', 'webhook_secret', 'payment_redirect_url'],
  openai: ['api_key', 'model', 'image_model', 'base_url', 'text_url'],
  gemini: [
    'api_key',
    'model',
    'text_model',
    'vision_model',
    'image_model',
    'image_url',
    'image_fallback_url',
    'image_mime',
  ],
  smtp: ['host', 'port', 'secure', 'user', 'pass', 'from'],
};

const buildDefaultConnectionConfig = (provider) => {
  if (provider === 'telegram') {
    const defaultMode = IS_SERVERLESS_RUNTIME ? 'webhook' : 'polling';
    const configuredMode = String(process.env.TELEGRAM_MODE || defaultMode).trim().toLowerCase();
    return {
      bot_username: String(process.env.TELEGRAM_BOT_USERNAME || '').trim(),
      bot_token: String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim(),
      mode: IS_SERVERLESS_RUNTIME ? 'webhook' : (configuredMode === 'webhook' ? 'webhook' : 'polling'),
      webhook_path: normalizeWebhookPath(process.env.TELEGRAM_WEBHOOK_PATH || '/webhook'),
      public_server_url: String(process.env.PUBLIC_SERVER_URL || '').trim(),
    };
  }
  if (provider === 'stripe') {
    return {
      publishable_key: String(process.env.STRIPE_PUBLISHABLE_KEY || process.env.VITE_STRIPE_PUBLISHABLE_KEY || '').trim(),
      secret_key: String(process.env.STRIPE_SECRET_KEY || '').trim(),
      webhook_secret: String(process.env.STRIPE_WEBHOOK_SECRET || '').trim(),
      payment_redirect_url: String(process.env.PAYMENT_REDIRECT_URL || process.env.CLIENT_BASE_URL || '').trim(),
    };
  }
  if (provider === 'openai') {
    return {
      api_key: String(process.env.OPENAI_API_KEY || '').trim(),
      model: String(process.env.OPENAI_MODEL || 'gpt-4o').trim(),
      image_model: String(process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1').trim(),
      base_url: String(process.env.OPENAI_BASE_URL || '').trim(),
      text_url: String(process.env.OPENAI_TEXT_URL || '').trim(),
    };
  }
  if (provider === 'gemini') {
    return {
      api_key: String(process.env.GEMINI_API_KEY || '').trim(),
      model: String(process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
      text_model: String(process.env.GEMINI_TEXT_MODEL || '').trim(),
      vision_model: String(process.env.GEMINI_VISION_MODEL || '').trim(),
      image_model: String(process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image').trim(),
      image_url: String(process.env.GEMINI_IMAGE_URL || '').trim(),
      image_fallback_url: String(process.env.GEMINI_IMAGE_FALLBACK_URL || '').trim(),
      image_mime: String(process.env.GEMINI_IMAGE_MIME || 'image/png').trim(),
    };
  }
  return {
    host: String(process.env.SMTP_HOST || '').trim(),
    port: String(process.env.SMTP_PORT || '').trim(),
    secure: String(process.env.SMTP_SECURE || 'true').trim(),
    user: String(process.env.SMTP_USER || '').trim(),
    pass: String(process.env.SMTP_PASS || '').trim(),
    from: String(process.env.SMTP_FROM || process.env.EMAIL_FROM || '').trim(),
  };
};

const buildDefaultConnectionRow = (provider) => {
  const config = buildDefaultConnectionConfig(provider);
  const isEnabled = provider === 'telegram'
    ? Boolean(config.bot_token)
    : provider === 'stripe'
      ? Boolean(config.secret_key)
      : provider === 'openai'
        ? Boolean(config.api_key)
        : provider === 'gemini'
          ? Boolean(config.api_key)
          : Boolean(config.host && config.user && config.pass);
  return { provider, isEnabled, config };
};

const sanitizeConnectionConfig = (provider, input) => {
  const allowedKeys = CONNECTION_CONFIG_KEYS[provider] || [];
  const source = input && typeof input === 'object' ? input : {};
  const output = {};
  for (const key of allowedKeys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      output[key] = String(source[key] ?? '').trim();
    }
  }
  if (provider === 'telegram') {
    const rawMode = String(output.mode || '').trim().toLowerCase();
    output.mode = rawMode === 'webhook' ? 'webhook' : 'polling';
    if (IS_SERVERLESS_RUNTIME) {
      output.mode = 'webhook';
    }
    output.webhook_path = normalizeWebhookPath(output.webhook_path || '/webhook');
  }
  return output;
};

const ensureIntegrationSettingsTable = async () => {
  if (!DB_AUTO_DDL) return;
  const providerCheck = CONNECTION_PROVIDER_ORDER.map((provider) => `'${provider}'`).join(', ');
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS integration_settings (
        provider VARCHAR(20) PRIMARY KEY,
        is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        config JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT integration_settings_provider_check
          CHECK (provider IN (${providerCheck}))
      )
    `
  );
  await pool.query(`ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_provider_check`);
  await pool.query(
    `
      ALTER TABLE integration_settings
      ADD CONSTRAINT integration_settings_provider_check
      CHECK (provider IN (${providerCheck}))
    `
  );
};

const seedIntegrationSettingsDefaults = async () => {
  if (!DB_AUTO_DDL) return;
  for (const provider of CONNECTION_PROVIDER_ORDER) {
    const row = buildDefaultConnectionRow(provider);
    await pool.query(
      `
        INSERT INTO integration_settings (provider, is_enabled, config)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (provider) DO NOTHING
      `,
      [provider, row.isEnabled, JSON.stringify(row.config)]
    );
  }
};

const buildConnectionRuntimeRow = (provider, row = null) => {
  const fallback = buildDefaultConnectionRow(provider);
  if (!row) {
    return fallback;
  }
  const dbConfig = row.config && typeof row.config === 'object' ? row.config : {};
  return {
    provider,
    isEnabled: row.is_enabled !== false,
    config: {
      ...fallback.config,
      ...dbConfig,
    },
  };
};

const applyConnectionRuntimeEnv = (provider, row) => {
  const config = row?.config && typeof row.config === 'object' ? row.config : {};
  const isEnabled = row?.isEnabled !== false;

  if (provider === 'telegram') {
    const token = isEnabled ? String(config.bot_token || '').trim() : '';
    const requestedMode = String(config.mode || 'polling').trim().toLowerCase();
    const resolvedMode = requestedMode === 'webhook'
      ? 'webhook'
      : (IS_SERVERLESS_RUNTIME ? 'webhook' : 'polling');
    process.env.BOT_TOKEN = token;
    process.env.TELEGRAM_BOT_TOKEN = token;
    process.env.TELEGRAM_BOT_USERNAME = String(config.bot_username || '').trim();
    process.env.TELEGRAM_MODE = resolvedMode;
    process.env.TELEGRAM_WEBHOOK_PATH = normalizeWebhookPath(config.webhook_path || '/webhook');
    process.env.PUBLIC_SERVER_URL = String(config.public_server_url || '').trim();
    return;
  }

  if (provider === 'stripe') {
    const publishableKey = String(config.publishable_key || '').trim();
    process.env.STRIPE_PUBLISHABLE_KEY = publishableKey;
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = publishableKey;
    process.env.PAYMENT_REDIRECT_URL = String(config.payment_redirect_url || '').trim();
    process.env.STRIPE_SECRET_KEY = isEnabled ? String(config.secret_key || '').trim() : '';
    process.env.STRIPE_WEBHOOK_SECRET = isEnabled ? String(config.webhook_secret || '').trim() : '';
    return;
  }

  if (provider === 'openai') {
    process.env.OPENAI_API_KEY = isEnabled ? String(config.api_key || '').trim() : '';
    process.env.OPENAI_MODEL = String(config.model || 'gpt-4o').trim() || 'gpt-4o';
    process.env.OPENAI_IMAGE_MODEL = String(config.image_model || 'gpt-image-1').trim() || 'gpt-image-1';
    process.env.OPENAI_BASE_URL = String(config.base_url || '').trim();
    process.env.OPENAI_TEXT_URL = String(config.text_url || '').trim();
    return;
  }

  if (provider === 'gemini') {
    process.env.GEMINI_API_KEY = isEnabled ? String(config.api_key || '').trim() : '';
    process.env.GEMINI_MODEL = String(config.model || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash';
    process.env.GEMINI_TEXT_MODEL = String(config.text_model || '').trim();
    process.env.GEMINI_VISION_MODEL = String(config.vision_model || '').trim();
    process.env.GEMINI_IMAGE_MODEL = String(config.image_model || 'gemini-2.5-flash-image').trim() || 'gemini-2.5-flash-image';
    process.env.GEMINI_IMAGE_URL = String(config.image_url || '').trim();
    process.env.GEMINI_IMAGE_FALLBACK_URL = String(config.image_fallback_url || '').trim();
    process.env.GEMINI_IMAGE_MIME = String(config.image_mime || 'image/png').trim() || 'image/png';
    return;
  }

  process.env.SMTP_HOST = String(config.host || '').trim();
  process.env.SMTP_PORT = String(config.port || '').trim();
  process.env.SMTP_SECURE = String(config.secure || 'true').trim() || 'true';
  process.env.SMTP_USER = String(config.user || '').trim();
  process.env.SMTP_PASS = isEnabled ? String(config.pass || '').trim() : '';
  const fromAddress = String(config.from || '').trim();
  process.env.SMTP_FROM = fromAddress;
  process.env.EMAIL_FROM = fromAddress;
};

const loadConnectionRowsFromDb = async () => {
  try {
    await ensureIntegrationSettingsTable();
    await seedIntegrationSettingsDefaults();
    const result = await pool.query(
      `
        SELECT provider, is_enabled, config
        FROM integration_settings
      `
    );
    return Array.isArray(result.rows) ? result.rows : [];
  } catch (error) {
    if (error?.code === '42P01') {
      return [];
    }
    throw error;
  }
};

const syncConnectionRuntimeFromDb = async () => {
  const rows = await loadConnectionRowsFromDb();
  const rowsByProvider = {};
  for (const row of rows) {
    const provider = String(row?.provider || '').trim().toLowerCase();
    if (!provider) continue;
    rowsByProvider[provider] = row;
  }

  const runtimeRows = CONNECTION_PROVIDER_ORDER.map((provider) =>
    buildConnectionRuntimeRow(provider, rowsByProvider[provider] || null)
  );
  for (const row of runtimeRows) {
    applyConnectionRuntimeEnv(row.provider, row);
  }
  refreshStripeRuntimeFromEnv();
  refreshOpenAiRuntimeFromEnv();
  refreshSmtpRuntimeFromEnv();
  return runtimeRows;
};

const ensurePlanSettingsTable = async () => {
  if (!DB_AUTO_DDL) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS plan_settings (
        tier VARCHAR(16) PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        price_usd_monthly NUMERIC(10,2) NOT NULL CHECK (price_usd_monthly >= 0),
        monthly_credits INTEGER NOT NULL CHECK (monthly_credits >= 0),
        is_editable BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT plan_settings_tier_check CHECK (tier IN ('free', 'basic', 'pro'))
      )
    `
  );

  for (const plan of getOrderedPlanConfigs()) {
    await pool.query(
      `
        INSERT INTO plan_settings (tier, name, price_usd_monthly, monthly_credits, is_editable)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (tier) DO NOTHING
      `,
      [plan.tier, plan.name, plan.priceUsdMonthly, plan.monthlyCredits]
    );
  }
};

const ensureTopupPackagesTable = async ({ force = false } = {}) => {
  if (!DB_AUTO_DDL && !force) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS topup_packages (
        credits INTEGER PRIMARY KEY CHECK (credits > 0),
        price_usd NUMERIC(10,2) NOT NULL CHECK (price_usd >= 0),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order SMALLINT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );

  const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM topup_packages`);
  const total = Number(countResult.rows?.[0]?.total || 0);
  if (total === 0) {
    for (const pack of DEFAULT_TOPUP_PACK_DEFINITIONS) {
      await pool.query(
        `
          INSERT INTO topup_packages (credits, price_usd, is_active, sort_order)
          VALUES ($1, $2, TRUE, $3)
          ON CONFLICT (credits) DO NOTHING
        `,
        [pack.credits, pack.priceUsd, pack.sortOrder]
      );
    }
  }
};

const ensureProjectApiKeysTable = async ({ force = false } = {}) => {
  if (!DB_AUTO_DDL && !force) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS project_api_keys (
        project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        api_key_hash CHAR(64) NOT NULL UNIQUE,
        api_key_encrypted TEXT NOT NULL,
        key_prefix VARCHAR(16) NOT NULL,
        key_last4 VARCHAR(4) NOT NULL,
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await pool.query(
    `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_project_api_keys_hash
      ON project_api_keys (api_key_hash)
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_project_api_keys_enabled
      ON project_api_keys (is_enabled)
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_project_api_keys_last_used
      ON project_api_keys (last_used_at DESC)
    `
  );
};

const ensureProjectApiLogsTable = async ({ force = false } = {}) => {
  if (!DB_AUTO_DDL && !force) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS project_api_logs (
        id UUID PRIMARY KEY DEFAULT app_uuid(),
        project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
        project_name TEXT,
        method VARCHAR(16) NOT NULL,
        endpoint_path TEXT NOT NULL,
        source VARCHAR(64),
        status_code INTEGER,
        level VARCHAR(16) NOT NULL CHECK (level IN ('info', 'error')),
        latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
        request_preview JSONB NOT NULL DEFAULT '{}'::jsonb,
        response_preview JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_project_api_logs_created_at
      ON project_api_logs (created_at DESC)
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_project_api_logs_project_created
      ON project_api_logs (project_id, created_at DESC)
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_project_api_logs_level_created
      ON project_api_logs (level, created_at DESC)
    `
  );
};

const ensureProjectApiPipelineTables = async ({ force = false } = {}) => {
  if (!DB_AUTO_DDL && !force) return;

  const defaultGenerateArraySql = toSqlTextArrayLiteral(PROJECT_API_GENERATE_PIPELINES);
  const defaultAnalyzeArraySql = toSqlTextArrayLiteral(PROJECT_API_ANALYZE_PIPELINES);
  const defaultGeneratePipeline = String(DEFAULT_PROJECT_API_PIPELINE_POLICY.defaultGeneratePipeline).replace(/'/g, "''");
  const defaultAnalyzePipeline = String(DEFAULT_PROJECT_API_PIPELINE_POLICY.defaultAnalyzePipeline).replace(/'/g, "''");

  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS project_api_runtime_settings (
        id SMALLINT PRIMARY KEY CHECK (id = ${PROJECT_API_RUNTIME_SETTINGS_SINGLETON_ID}),
        external_generate_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        external_analyze_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );

  await pool.query(
    `
      INSERT INTO project_api_runtime_settings (
        id, external_generate_enabled, external_analyze_enabled
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO NOTHING
    `,
    [
      PROJECT_API_RUNTIME_SETTINGS_SINGLETON_ID,
      DEFAULT_PROJECT_API_RUNTIME_SETTINGS.externalGenerateEnabled !== false,
      DEFAULT_PROJECT_API_RUNTIME_SETTINGS.externalAnalyzeEnabled !== false,
    ]
  );

  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS project_api_pipeline_policies (
        project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        default_generate_pipeline VARCHAR(80) NOT NULL DEFAULT '${defaultGeneratePipeline}',
        allowed_generate_pipelines TEXT[] NOT NULL DEFAULT ${defaultGenerateArraySql},
        allow_generate_override BOOLEAN NOT NULL DEFAULT TRUE,
        default_analyze_pipeline VARCHAR(80) NOT NULL DEFAULT '${defaultAnalyzePipeline}',
        allowed_analyze_pipelines TEXT[] NOT NULL DEFAULT ${defaultAnalyzeArraySql},
        allow_analyze_override BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
};

const ensureProjectApiPipelinePolicyRow = async (projectId) => {
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) return null;

  const defaults = buildDefaultProjectApiPipelinePolicy();
  await pool.query(
    `
      INSERT INTO project_api_pipeline_policies (
        project_id,
        default_generate_pipeline,
        allowed_generate_pipelines,
        allow_generate_override,
        default_analyze_pipeline,
        allowed_analyze_pipelines,
        allow_analyze_override
      )
      VALUES ($1::uuid, $2, $3::text[], $4, $5, $6::text[], $7)
      ON CONFLICT (project_id) DO NOTHING
    `,
    [
      normalizedProjectId,
      defaults.defaultGeneratePipeline,
      defaults.allowedGeneratePipelines,
      defaults.allowGenerateOverride !== false,
      defaults.defaultAnalyzePipeline,
      defaults.allowedAnalyzePipelines,
      defaults.allowAnalyzeOverride !== false,
    ]
  );

  const result = await pool.query(
    `
      SELECT
        project_id,
        default_generate_pipeline,
        allowed_generate_pipelines,
        allow_generate_override,
        default_analyze_pipeline,
        allowed_analyze_pipelines,
        allow_analyze_override,
        created_at,
        updated_at
      FROM project_api_pipeline_policies
      WHERE project_id = $1::uuid
      LIMIT 1
    `,
    [normalizedProjectId]
  );

  return normalizeProjectApiPipelinePolicyRow(result.rows[0] || { project_id: normalizedProjectId });
};

const getProjectApiRuntimeSettings = async () => {
  await ensureProjectApiPipelineTables({ force: true });
  const result = await pool.query(
    `
      SELECT
        external_generate_enabled,
        external_analyze_enabled,
        updated_at
      FROM project_api_runtime_settings
      WHERE id = $1
      LIMIT 1
    `,
    [PROJECT_API_RUNTIME_SETTINGS_SINGLETON_ID]
  );
  return normalizeProjectApiRuntimeSettingsRow(result.rows[0] || null);
};

const getProjectApiPipelinePolicy = async (projectId) => {
  const normalizedProjectId = String(projectId || '').trim();
  if (!normalizedProjectId) {
    return normalizeProjectApiPipelinePolicyRow(null);
  }
  await ensureProjectApiPipelineTables({ force: true });
  const result = await pool.query(
    `
      SELECT
        project_id,
        default_generate_pipeline,
        allowed_generate_pipelines,
        allow_generate_override,
        default_analyze_pipeline,
        allowed_analyze_pipelines,
        allow_analyze_override,
        created_at,
        updated_at
      FROM project_api_pipeline_policies
      WHERE project_id = $1::uuid
      LIMIT 1
    `,
    [normalizedProjectId]
  );
  return normalizeProjectApiPipelinePolicyRow(result.rows[0] || { project_id: normalizedProjectId });
};

const ensureStripeTopupHistoryTable = async () => {
  if (!DB_AUTO_DDL) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS stripe_topup_history (
        session_id VARCHAR(255) PRIMARY KEY,
        telegram_id BIGINT NOT NULL,
        credits_added INTEGER NOT NULL CHECK (credits_added > 0),
        source VARCHAR(64) NOT NULL DEFAULT 'stripe',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  );
};

const ensureTelegramGenerationJobsTable = async () => {
  if (!DB_AUTO_DDL) return;
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS telegram_generation_jobs (
        job_token VARCHAR(64) PRIMARY KEY,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        telegram_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'queued',
        prompt TEXT NOT NULL,
        reference_image_url TEXT NOT NULL,
        reference_mime_type VARCHAR(100),
        reference_source_kind VARCHAR(32) NOT NULL DEFAULT 'document',
        reference_file_name TEXT,
        reference_mode VARCHAR(16) NOT NULL DEFAULT 'edit',
        logo_image_url TEXT,
        logo_mime_type VARCHAR(100),
        draft_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        variant_count SMALLINT NOT NULL DEFAULT 2 CHECK (variant_count > 0),
        reserved_credits INTEGER NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
        generated_count INTEGER NOT NULL DEFAULT 0 CHECK (generated_count >= 0),
        result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        error_text TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        queued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
      )
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_tg_generation_jobs_status_queued
      ON telegram_generation_jobs (status, queued_at ASC)
    `
  );
  await pool.query(
    `
      CREATE INDEX IF NOT EXISTS idx_tg_generation_jobs_telegram_created
      ON telegram_generation_jobs (telegram_id, created_at DESC)
    `
  );
};

const loadPlanDefinitionsFromDb = async () => {
  const plansResult = await pool.query(
    `
      SELECT tier, name, price_usd_monthly, monthly_credits
      FROM plan_settings
    `
  );
  const merged = JSON.parse(JSON.stringify(DEFAULT_PLAN_DEFINITIONS));
  for (const row of plansResult.rows) {
    const tier = normalizePlanTier(row.tier);
    merged[tier] = {
      tier,
      name: String(row.name || DEFAULT_PLAN_DEFINITIONS[tier].name),
      priceUsdMonthly: Number(row.price_usd_monthly ?? DEFAULT_PLAN_DEFINITIONS[tier].priceUsdMonthly),
      monthlyCredits: Number(row.monthly_credits ?? DEFAULT_PLAN_DEFINITIONS[tier].monthlyCredits),
    };
  }
  PLAN_DEFINITIONS = merged;
};

const loadTopupPackagesFromDb = async () => {
  let topupResult = null;
  try {
    topupResult = await pool.query(
      `
        SELECT credits, price_usd, is_active, sort_order
        FROM topup_packages
        ORDER BY sort_order ASC, credits ASC
      `
    );
  } catch (error) {
    if (error?.code !== '42P01') throw error;
    await ensureTopupPackagesTable({ force: true });
    topupResult = await pool.query(
      `
        SELECT credits, price_usd, is_active, sort_order
        FROM topup_packages
        ORDER BY sort_order ASC, credits ASC
      `
    );
  }
  const next = [];
  for (const row of topupResult.rows) {
    const normalized = normalizeTopupPackageDraft({
      credits: row.credits,
      priceUsd: row.price_usd,
      isActive: row.is_active,
      sortOrder: row.sort_order,
    });
    if (normalized.credits <= 0) continue;
    if (normalized.priceUsd < 0) continue;
    next.push(normalized);
  }

  if (!next.length) {
    TOPUP_PACK_DEFINITIONS = JSON.parse(JSON.stringify(DEFAULT_TOPUP_PACK_DEFINITIONS));
    return;
  }
  TOPUP_PACK_DEFINITIONS = sortTopupPackages(next);
};

const syncPlanDefinitions = async () => {
  await ensurePlanSettingsTable();
  await loadPlanDefinitionsFromDb();
};
const syncTopupPackages = async ({ force = false } = {}) => {
  await ensureTopupPackagesTable({ force });
  await loadTopupPackagesFromDb();
};
const isAdminUser = (row) => String(row?.role || '').toLowerCase() === 'admin';
const isUsageLimitExemptUser = (row) => isAdminUser(row);
const isSuperAdminUser = (row) =>
  isAdminUser(row) &&
  String(row?.username || '').toLowerCase() === String(DEFAULT_SADMIN_USERNAME || 'sadmin').toLowerCase();

const buildAuthUserPayload = (row) => {
  const hasUnlimitedUsage = isUsageLimitExemptUser(row);
  const resolvedQuota = Number(row.daily_credit_quota || getPlanConfig(row.plan_tier).monthlyCredits);

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    role: row.role,
    isAdmin: isAdminUser(row),
    isSuperAdmin: isSuperAdminUser(row),
    hasUnlimitedUsage,
    credits: Number(row.credits || 0),
    planTier: normalizePlanTier(row.plan_tier),
    planStatus: row.plan_status || 'inactive',
    monthlyCreditQuota: hasUnlimitedUsage ? null : resolvedQuota,
    dailyCreditQuota: hasUnlimitedUsage ? null : resolvedQuota,
    telegramId: row.telegram_id ? String(row.telegram_id) : null,
    phone: row?.bot_data?.phone || '',
    lastLoginAt: row.last_login_at || null,
  };
};

const signAuthToken = (userRow) =>
  jwt.sign(
    {
      sub: userRow.id,
      username: userRow.username,
      role: userRow.role,
    },
    AUTH_JWT_SECRET,
    {
      expiresIn: AUTH_JWT_EXPIRES_IN,
    }
  );

const normalizeAuthUsername = (value) => String(value || '').trim().toLowerCase();

const ensureDevBypassSuperAdminUser = async () => {
  const existing = await pool.query(
    `
      SELECT *
      FROM users
      WHERE username = $1
      LIMIT 1
    `,
    [DEFAULT_SADMIN_USERNAME]
  );

  const proPlan = getPlanConfig('pro');
  const hash = await bcrypt.hash(DEV_AUTH_BYPASS_PASSWORD, 10);

  if (!existing.rowCount) {
    const created = await pool.query(
      `
        INSERT INTO users (
          username, password_hash, email, role, bot_state, credits,
          plan_tier, plan_status, daily_credit_quota, last_credit_reset, last_login_at, is_active
        )
        VALUES ($1, $2, $3, 'admin', 'IDLE', $4, $5, 'active', $4, CURRENT_DATE, NOW(), TRUE)
        RETURNING *
      `,
      [DEFAULT_SADMIN_USERNAME, hash, 'sadmin@example.com', proPlan.monthlyCredits, proPlan.tier]
    );
    return created.rows[0];
  }

  const user = existing.rows[0];
  await pool.query(
    `
      UPDATE users
      SET
        role = 'admin',
        is_active = TRUE,
        password_hash = COALESCE(password_hash, $1),
        plan_tier = COALESCE(plan_tier, $2),
        plan_status = COALESCE(plan_status, 'active'),
        daily_credit_quota = COALESCE(daily_credit_quota, $3),
        credits = COALESCE(credits, $3)
      WHERE id = $4
    `,
    [hash, proPlan.tier, proPlan.monthlyCredits, user.id]
  );

  const refreshed = await pool.query(
    `
      SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
    `,
    [user.id]
  );
  return refreshed.rows[0] || user;
};

const getBearerToken = (req) => {
  const header = String(req.headers.authorization || '');
  if (!header.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return header.slice(7).trim();
};

const applyPlanToUser = async ({
  userId,
  planTier,
  stripeCustomerId = null,
  stripeSubscriptionId = null,
}) => {
  const plan = getPlanConfig(planTier);
  const updated = await pool.query(
    `
      UPDATE users
      SET plan_tier = $1,
          plan_status = 'active',
          daily_credit_quota = $2,
          credits = $2,
          last_credit_reset = CURRENT_DATE,
          stripe_customer_id = COALESCE($3, stripe_customer_id),
          stripe_subscription_id = COALESCE($4, stripe_subscription_id),
          updated_at = NOW()
      WHERE id = $5
      RETURNING *
    `,
    [plan.tier, plan.monthlyCredits, stripeCustomerId, stripeSubscriptionId, userId]
  );
  return updated.rows[0] || null;
};

const requireAuth = async (req, res, next) => {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (ALLOW_DEV_AUTH_BYPASS && token === DEV_AUTH_BYPASS_TOKEN) {
      req.user = await ensureDevBypassSuperAdminUser();
      return next();
    }

    let decoded = null;
    try {
      decoded = jwt.verify(token, AUTH_JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const userResult = await pool.query(
      `
        SELECT *
        FROM users
        WHERE id = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [decoded.sub]
    );
    if (!userResult.rowCount) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    req.user = userResult.rows[0];
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Auth middleware failed', details: error.message });
  }
};

const requireSuperAdmin = async (req, res, next) => {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    if (ALLOW_DEV_AUTH_BYPASS && token === DEV_AUTH_BYPASS_TOKEN) {
      req.user = await ensureDevBypassSuperAdminUser();
      return next();
    }

    let decoded = null;
    try {
      decoded = jwt.verify(token, AUTH_JWT_SECRET);
    } catch (error) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const userResult = await pool.query(
      `SELECT * FROM users WHERE id = $1 AND is_active = TRUE LIMIT 1`,
      [decoded.sub]
    );
    if (!userResult.rowCount) return res.status(401).json({ error: 'User not found' });
    if (!isSuperAdminUser(userResult.rows[0])) {
      return res.status(403).json({ error: 'Forbidden. Super admin only.' });
    }
    req.user = userResult.rows[0];
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Auth middleware failed', details: error.message });
  }
};

const requireAuthOrInternal = async (req, res, next) => {
  const internalKey = String(req.headers['x-internal-api-key'] || '');
  if (INTERNAL_API_KEY && internalKey === INTERNAL_API_KEY) {
    req.user = null;
    return next();
  }
  return requireAuth(req, res, next);
};

const requireProjectApiKey = async (req, res, next) => {
  const projectApiKey = String(req.headers['x-project-api-key'] || '').trim();
  if (!projectApiKey) {
    return res.status(401).json({ error: 'Missing x-project-api-key header' });
  }

  try {
    await ensureProjectApiKeysTable({ force: true });
    await ensureProjectApiPipelineTables({ force: true });
    const keyHash = hashProjectApiKey(projectApiKey);
    const result = await pool.query(
      `
        SELECT
          pak.project_id,
          pak.is_enabled,
          p.name AS project_name,
          p.owner_user_id
        FROM project_api_keys pak
        JOIN projects p ON p.id = pak.project_id
        WHERE pak.api_key_hash = $1
        LIMIT 1
      `,
      [keyHash]
    );
    if (!result.rowCount) {
      return res.status(401).json({ error: 'Invalid project API key' });
    }

    const row = result.rows[0];
    if (row.is_enabled === false) {
      return res.status(403).json({ error: 'Project API key is disabled' });
    }

    await pool.query(
      `
        UPDATE project_api_keys
        SET last_used_at = NOW(),
            updated_at = NOW()
        WHERE project_id = $1
      `,
      [row.project_id]
    );

    req.projectApi = {
      projectId: String(row.project_id),
      projectName: String(row.project_name || ''),
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    };
    req.user = null;
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Project API auth failed', details: error.message });
  }
};

const normalizeExternalGeneratePayloadToWebDefaults = (req, res, next) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const hasReferenceImage = typeof body.referenceImage === 'string' && body.referenceImage.startsWith('data:');
  const hasReferenceMode = typeof body.referenceMode === 'string' && String(body.referenceMode || '').trim() !== '';
  const hasSkipCaption = Object.prototype.hasOwnProperty.call(body, 'skipCaptionGeneration');
  const promptMode = String(body.promptMode || body.prompt_mode || '').trim().toLowerCase();
  const buildUnderlyingPromptRaw = body.buildUnderlyingPrompt ?? body.build_underlying_prompt;
  const normalizeBoolean = (value, fallback = null) => {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return fallback;
    if (['true', '1', 'yes', 'on', 'enable', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disable', 'disabled'].includes(normalized)) return false;
    return fallback;
  };
  const pickFirstNonEmpty = (...values) => {
    for (const value of values) {
      const text = String(value ?? '').trim();
      if (text) return text;
    }
    return '';
  };
  const promptBuilderInput = {
    productName: pickFirstNonEmpty(body.productName, body.product_name, body.product_focus, body.product),
    mainIngredient: pickFirstNonEmpty(body.mainIngredient, body.main_ingredient, body.main_theme, body.ingredient),
    visualMood: pickFirstNonEmpty(body.visualMood, body.visual_mood, body.mood),
    dynamicElements: pickFirstNonEmpty(body.dynamicElements, body.dynamic_elements),
    colorPalette: pickFirstNonEmpty(body.colorPalette, body.color_palette, body.palette),
    backgroundStyle: pickFirstNonEmpty(body.backgroundStyle, body.background_style, body.background_environment, body.background),
    brandName: pickFirstNonEmpty(body.brandName, body.brand_name, body.brandText, body.brand_text),
    ctaText: pickFirstNonEmpty(body.ctaText, body.cta_text, body.cta),
    aspectRatio: normalizeAnalyzeAspectRatio(
      pickFirstNonEmpty(body.aspectRatio, body.aspect_ratio, body.format, body.ratio)
    ),
    lightingFocus: pickFirstNonEmpty(body.lightingFocus, body.lighting_focus, body.lighting),
    extraNotes: pickFirstNonEmpty(body.extraNotes, body.extra_notes, body.additionalDirectives, body.additional_directives),
    addQualityTags: normalizeBoolean(body.addQualityTags ?? body.add_quality_tags, true) !== false,
    hasLogoImage: Boolean(
      (typeof body.logoImage === 'string' && body.logoImage.startsWith('data:')) ||
      (typeof body.logo_image === 'string' && body.logo_image.startsWith('data:')) ||
      normalizeBoolean(body.hasLogoImage ?? body.has_logo_image, false)
    ),
  };
  const hasPromptBuilderFields = [
    promptBuilderInput.productName,
    promptBuilderInput.mainIngredient,
    promptBuilderInput.visualMood,
    promptBuilderInput.dynamicElements,
    promptBuilderInput.colorPalette,
    promptBuilderInput.backgroundStyle,
    promptBuilderInput.brandName,
    promptBuilderInput.ctaText,
    promptBuilderInput.aspectRatio,
    promptBuilderInput.lightingFocus,
    promptBuilderInput.extraNotes,
  ].some(Boolean);
  const explicitBuildFlag = normalizeBoolean(buildUnderlyingPromptRaw, null);
  const shouldBuildUnderlyingPrompt =
    explicitBuildFlag === true ||
    promptMode === 'builder' ||
    promptMode === 'fields' ||
    (explicitBuildFlag !== false && hasPromptBuilderFields);

  if (!hasReferenceMode) {
    body.referenceMode = 'auto';
  }
  if (!hasSkipCaption) {
    body.skipCaptionGeneration = true;
  }
  if (promptBuilderInput.aspectRatio) {
    body.aspectRatio = promptBuilderInput.aspectRatio;
  }
  if (!hasReferenceImage && Object.prototype.hasOwnProperty.call(body, 'strictReferenceLock')) {
    body.strictReferenceLock = false;
  }
  if (shouldBuildUnderlyingPrompt) {
    const builtPrompt = buildMainPrompt(promptBuilderInput);
    body.prompt = builtPrompt;
    req.externalGeneratePromptMeta = {
      tag: 'UNDERLYING_PROMPT_BUILT',
      source: hasPromptBuilderFields ? 'builder_fields' : 'builder_forced',
      underlyingPrompt: builtPrompt,
      promptBuilderInput,
    };
  } else {
    req.externalGeneratePromptMeta = {
      tag: 'UNDERLYING_PROMPT_RAW',
      source: 'raw_prompt',
      underlyingPrompt: String(body.prompt || '').trim(),
    };
  }

  req.body = body;
  return next();
};

const normalizeExternalAnalyzePayloadToWebDefaults = (req, res, next) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  if (typeof body.provider !== 'string' || !String(body.provider || '').trim()) {
    body.provider = 'gemini';
  }
  req.body = body;
  return next();
};

const resolveRequestedPipelineFromBody = (body = {}) =>
  normalizePipelineToken(body?.pipelineName || body?.pipeline || '');

const resolveEffectivePipelineFromPolicy = ({
  requestedPipeline,
  allowOverride,
  allowedPipelines,
  defaultPipeline,
}) => {
  const allowedSet = new Set(cloneStringList(allowedPipelines).map((item) => normalizePipelineToken(item)));
  const normalizedDefault = normalizePipelineToken(defaultPipeline);
  const effectiveDefault = normalizedDefault;
  const normalizedRequested = normalizePipelineToken(requestedPipeline);
  const requestedProvided = Boolean(normalizedRequested);
  const requestAllowed = requestedProvided && allowedSet.has(normalizedRequested);
  const overrideApplied = Boolean(allowOverride) && requestAllowed;
  const overrideRejected = requestedProvided && !overrideApplied;

  return {
    requestedPipeline: normalizedRequested,
    requestedProvided,
    effectivePipeline: overrideApplied ? normalizedRequested : effectiveDefault,
    overrideApplied,
    overrideRejected,
    rejectionReason:
      requestedProvided && !Boolean(allowOverride)
        ? 'override_disabled'
        : requestedProvided && !requestAllowed
          ? 'pipeline_not_allowed'
          : null,
    shouldRejectRequest: overrideRejected,
    allowedPipelines: Array.from(allowedSet),
  };
};

const applyGeneratePipelineToBody = (body = {}, effectivePipeline = '') => {
  const nextBody = body && typeof body === 'object' ? { ...body } : {};
  const pipeline = normalizePipelineToken(effectivePipeline);
  const hasReferenceImage =
    typeof nextBody.referenceImage === 'string' && String(nextBody.referenceImage || '').startsWith('data:');

  if (pipeline === PIPELINE_NAME_OPENAI_IMAGE) {
    nextBody.provider = 'openai';
    nextBody.referenceMode = 'openai';
    return nextBody;
  }

  nextBody.provider = 'gemini';
  if (pipeline === PIPELINE_NAME_GEMINI_REFERENCE_GUIDED) {
    nextBody.referenceMode = hasReferenceImage ? 'overlay' : 'edit';
  } else {
    nextBody.referenceMode = 'edit';
  }
  return nextBody;
};

const applyAnalyzePipelineToBody = (body = {}, effectivePipeline = '') => {
  const nextBody = body && typeof body === 'object' ? { ...body } : {};
  const pipeline = normalizePipelineToken(effectivePipeline);
  nextBody.provider = pipeline === PIPELINE_NAME_OPENAI_ANALYZE ? 'openai' : 'gemini';
  return nextBody;
};

const enforceExternalPipelinePolicy = (endpointType) => async (req, res, next) => {
  const projectId = String(req?.projectApi?.projectId || '').trim();
  if (!projectId) {
    return next();
  }

  try {
    await ensureProjectApiPipelineTables({ force: true });
    const runtimeSettings = await getProjectApiRuntimeSettings();
    if (endpointType === 'generate' && runtimeSettings.externalGenerateEnabled === false) {
      return res.status(403).json({
        error: 'External generate endpoint is disabled by superadmin',
      });
    }
    if (endpointType === 'analyze' && runtimeSettings.externalAnalyzeEnabled === false) {
      return res.status(403).json({
        error: 'External analyze endpoint is disabled by superadmin',
      });
    }

    const policy = await ensureProjectApiPipelinePolicyRow(projectId);
    const requestedPipeline = resolveRequestedPipelineFromBody(req.body);
    const hasExternalReferenceImage =
      endpointType === 'generate' &&
      typeof req?.body?.referenceImage === 'string' &&
      String(req.body.referenceImage || '').startsWith('data:') &&
      typeof req?.body?.productImage === 'string' &&
      String(req.body.productImage || '').startsWith('data:');
    const forceReferencePipelineForExternal =
      hasExternalReferenceImage &&
      String(process.env.EXTERNAL_FORCE_REFERENCE_PIPELINE || 'true').trim().toLowerCase() !== 'false';

    if (forceReferencePipelineForExternal) {
      const effectivePipeline = PIPELINE_NAME_GEMINI_REFERENCE_GUIDED;
      req.body = applyGeneratePipelineToBody(req.body, effectivePipeline);
      req.body.pipelineName = effectivePipeline;
      req.projectApiPolicy = {
        endpointType,
        runtimeSettings,
        policy,
        requestedPipeline,
        requestedPipelineProvided: Boolean(requestedPipeline),
        effectivePipeline,
        overrideApplied: false,
        overrideRejected: false,
        rejectionReason: null,
        allowedPipelines: cloneStringList(policy.allowedGeneratePipelines),
        forceReferencePipeline: true,
      };
      return next();
    }

    const decision =
      endpointType === 'analyze'
        ? resolveEffectivePipelineFromPolicy({
            requestedPipeline,
            allowOverride: policy.allowAnalyzeOverride,
            allowedPipelines: policy.allowedAnalyzePipelines,
            defaultPipeline: policy.defaultAnalyzePipeline,
          })
        : resolveEffectivePipelineFromPolicy({
            requestedPipeline,
            allowOverride: policy.allowGenerateOverride,
            allowedPipelines: policy.allowedGeneratePipelines,
            defaultPipeline: policy.defaultGeneratePipeline,
          });

    if (decision.shouldRejectRequest) {
      return res.status(403).json({
        error: 'Requested pipeline is not enabled for this project',
        requestedPipeline: decision.requestedPipeline || undefined,
        rejectionReason: decision.rejectionReason || undefined,
        allowedPipelines: decision.allowedPipelines,
      });
    }

    const effectivePipeline = decision.effectivePipeline ||
      (endpointType === 'analyze' ? PIPELINE_NAME_GEMINI_EDIT : PIPELINE_NAME_GEMINI_EDIT);

    req.body =
      endpointType === 'analyze'
        ? applyAnalyzePipelineToBody(req.body, effectivePipeline)
        : applyGeneratePipelineToBody(req.body, effectivePipeline);

    req.body.pipelineName = effectivePipeline;
    req.projectApiPolicy = {
      endpointType,
      runtimeSettings,
      policy,
      requestedPipeline: decision.requestedPipeline || '',
      requestedPipelineProvided: decision.requestedProvided,
      effectivePipeline,
      overrideApplied: decision.overrideApplied,
      overrideRejected: decision.overrideRejected,
      rejectionReason: decision.rejectionReason,
      allowedPipelines: decision.allowedPipelines,
    };

    return next();
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to apply external pipeline policy',
      details: error.message,
    });
  }
};

const normalizeProjectApiLogKey = (key) =>
  String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const truncateProjectApiLogString = (value, limit = PROJECT_API_LOG_STRING_LIMIT) => {
  const text = String(value ?? '');
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3))}...`;
};

const sanitizeProjectApiLogValue = (value, options = {}) => {
  const {
    depth = 0,
    omitKeys = new Set(),
  } = options;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '[data-url omitted]';
    return truncateProjectApiLogString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[buffer:${value.length}]`;

  if (depth >= PROJECT_API_LOG_MAX_DEPTH) {
    if (Array.isArray(value)) return `[array:${value.length}]`;
    return '[max-depth]';
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, PROJECT_API_LOG_MAX_ARRAY_ITEMS)
      .map((item) => sanitizeProjectApiLogValue(item, {
        depth: depth + 1,
        omitKeys,
      }));
    if (value.length > PROJECT_API_LOG_MAX_ARRAY_ITEMS) {
      items.push(`[+${value.length - PROJECT_API_LOG_MAX_ARRAY_ITEMS} more]`);
    }
    return items;
  }

  if (typeof value === 'object') {
    const output = {};
    const entries = Object.entries(value).slice(0, PROJECT_API_LOG_MAX_OBJECT_KEYS);
    for (const [rawKey, rawValue] of entries) {
      const key = String(rawKey || '');
      const normalizedKey = normalizeProjectApiLogKey(key);
      if (omitKeys.has(normalizedKey)) {
        output[key] = '[omitted]';
        continue;
      }
      output[key] = sanitizeProjectApiLogValue(rawValue, {
        depth: depth + 1,
        omitKeys,
      });
    }
    const allKeyCount = Object.keys(value).length;
    if (allKeyCount > PROJECT_API_LOG_MAX_OBJECT_KEYS) {
      output.__truncatedKeys = allKeyCount - PROJECT_API_LOG_MAX_OBJECT_KEYS;
    }
    return output;
  }

  return truncateProjectApiLogString(String(value));
};

const buildProjectApiLogHeaderPreview = (headers = {}) => {
  const safeHeaders = {};
  const entries = Object.entries(headers).slice(0, PROJECT_API_LOG_MAX_OBJECT_KEYS);
  for (const [rawKey, rawValue] of entries) {
    const key = String(rawKey || '').toLowerCase();
    const normalizedKey = normalizeProjectApiLogKey(key);
    if (PROJECT_API_LOG_SENSITIVE_HEADER_KEYS.has(normalizedKey)) {
      safeHeaders[key] = '[redacted]';
      continue;
    }
    safeHeaders[key] = sanitizeProjectApiLogValue(rawValue, { depth: 0 });
  }
  return safeHeaders;
};

const normalizeApiLogResponsePayload = (payload) => {
  if (payload && typeof payload === 'object') return payload;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch (error) {
        return { text: truncateProjectApiLogString(trimmed) };
      }
    }
    return { text: truncateProjectApiLogString(trimmed) };
  }
  if (payload === null || payload === undefined) return {};
  return { value: sanitizeProjectApiLogValue(payload, { depth: 0 }) };
};

const buildProjectApiLogRequestPreview = (req) => {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const policyContext = req?.projectApiPolicy && typeof req.projectApiPolicy === 'object'
    ? req.projectApiPolicy
    : null;
  const promptMeta =
    req?.externalGeneratePromptMeta && typeof req.externalGeneratePromptMeta === 'object'
      ? req.externalGeneratePromptMeta
      : null;
  const resolvedUnderlyingPrompt = String(
    promptMeta?.underlyingPrompt || body?.prompt || ''
  ).trim();
  return {
    method: String(req?.method || '').toUpperCase(),
    path: String(req?.path || PROJECT_API_EXTERNAL_GENERATE_PATH),
    source: truncateProjectApiLogString(String(body?.source || ''), 80),
    referenceMode: truncateProjectApiLogString(String(body?.referenceMode || ''), 80),
    provider: truncateProjectApiLogString(String(body?.provider || ''), 32),
    requestedPipeline: truncateProjectApiLogString(
      String(policyContext?.requestedPipeline || body?.pipelineName || body?.pipeline || ''),
      80
    ),
    effectivePipeline: truncateProjectApiLogString(String(policyContext?.effectivePipeline || ''), 80),
    promptTag: truncateProjectApiLogString(String(promptMeta?.tag || ''), 80),
    promptSource: truncateProjectApiLogString(String(promptMeta?.source || ''), 80),
    underlyingPromptPreview: truncateProjectApiLogString(resolvedUnderlyingPrompt, 420),
    generationVariant: truncateProjectApiLogString(String(body?.generationVariant || ''), 80),
    promptPreview: truncateProjectApiLogString(String(body?.prompt || ''), 240),
    headers: buildProjectApiLogHeaderPreview(req?.headers || {}),
    body: sanitizeProjectApiLogValue(body, { depth: 0, omitKeys: PROJECT_API_LOG_REQUEST_OMIT_KEYS }),
  };
};

const buildProjectApiLogResponsePreview = ({ statusCode, payload }) => ({
  statusCode: Number(statusCode || 0),
  ok: Number(statusCode || 0) >= 200 && Number(statusCode || 0) < 300,
  body: sanitizeProjectApiLogValue(
    normalizeApiLogResponsePayload(payload),
    { depth: 0, omitKeys: PROJECT_API_LOG_RESPONSE_OMIT_KEYS }
  ),
});

const extractProjectApiLogErrorText = ({ statusCode, payload }) => {
  if (Number(statusCode || 0) < 400) return null;
  const normalized = normalizeApiLogResponsePayload(payload);
  const candidate =
    normalized?.details ||
    normalized?.error ||
    normalized?.message ||
    normalized?.text ||
    `HTTP ${Number(statusCode || 0)}`;
  const text = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
  return truncateProjectApiLogString(text, 1000);
};

const maybeCleanupProjectApiLogs = async () => {
  const now = Date.now();
  if (projectApiLogCleanupRunning) return;
  if (now - projectApiLogCleanupLastAt < PROJECT_API_LOG_CLEANUP_INTERVAL_MS) return;

  projectApiLogCleanupRunning = true;
  projectApiLogCleanupLastAt = now;
  try {
    await ensureProjectApiLogsTable({ force: true });
    await pool.query(
      `
        DELETE FROM project_api_logs
        WHERE created_at < NOW() - INTERVAL '${PROJECT_API_LOG_RETENTION_INTERVAL_SQL}'
      `
    );
  } catch (error) {
    if (error?.code !== '42P01') {
      console.warn('Project API log cleanup failed:', error.message);
    }
  } finally {
    projectApiLogCleanupRunning = false;
  }
};

const persistProjectExternalApiLog = async ({
  req,
  res,
  responsePayload,
  startedAtMs,
}) => {
  try {
    await ensureProjectApiLogsTable({ force: true });
    const statusCode = Number(res?.statusCode || 0) || 0;
    const level = statusCode >= 400 ? 'error' : 'info';
    const requestPreview = buildProjectApiLogRequestPreview(req);
    const responsePreview = buildProjectApiLogResponsePreview({ statusCode, payload: responsePayload });
    const errorText = extractProjectApiLogErrorText({ statusCode, payload: responsePayload });
    const latencyMs = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
    const source = truncateProjectApiLogString(String(req?.body?.source || ''), 64) || null;

    await pool.query(
      `
        INSERT INTO project_api_logs (
          project_id, project_name, method, endpoint_path, source,
          status_code, level, latency_ms, request_preview, response_preview, error_text
        )
        VALUES (
          $1::uuid, $2, $3, $4, $5,
          $6, $7, $8, $9::jsonb, $10::jsonb, $11
        )
      `,
      [
        req?.projectApi?.projectId ? String(req.projectApi.projectId) : null,
        req?.projectApi?.projectName ? String(req.projectApi.projectName) : null,
        String(req?.method || '').toUpperCase() || 'POST',
        String(req?.path || PROJECT_API_EXTERNAL_GENERATE_PATH),
        source,
        statusCode,
        level,
        latencyMs,
        JSON.stringify(requestPreview || {}),
        JSON.stringify(responsePreview || {}),
        errorText,
      ]
    );

    await maybeCleanupProjectApiLogs();
  } catch (error) {
    if (error?.code !== '42P01') {
      console.warn('Project external API log write failed:', error.message);
    }
  }
};

const attachProjectApiExternalLogCapture = (req, res, next) => {
  const startedAtMs = Date.now();
  let responsePayload = null;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = function patchedJson(payload) {
    responsePayload = payload;
    return originalJson(payload);
  };

  res.send = function patchedSend(payload) {
    if (responsePayload === null || responsePayload === undefined) {
      responsePayload = payload;
    }
    return originalSend(payload);
  };

  res.once('finish', () => {
    void persistProjectExternalApiLog({
      req,
      res,
      responsePayload,
      startedAtMs,
    });
  });

  return next();
};

const ensureDefaultAdminUser = async () => {
  const existing = await pool.query(
    `
      SELECT id, password_hash
      FROM users
      WHERE username = $1
      LIMIT 1
    `,
    [DEFAULT_ADMIN_USERNAME]
  );

  if (!existing.rowCount) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    const freePlan = getPlanConfig('free');
    await pool.query(
      `
        INSERT INTO users (
          username, password_hash, email, role, bot_state, credits, plan_tier, plan_status, daily_credit_quota, last_credit_reset
        )
        VALUES ($1, $2, $3, 'admin', 'IDLE', $4, $5, 'active', $4, CURRENT_DATE)
      `,
      [DEFAULT_ADMIN_USERNAME, hash, null, freePlan.monthlyCredits, freePlan.tier]
    );
    console.log(`Default DB admin created: ${DEFAULT_ADMIN_USERNAME}`);
    return;
  }

  if (!existing.rows[0].password_hash) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await pool.query(
      `
        UPDATE users
        SET password_hash = $1
        WHERE id = $2
      `,
      [hash, existing.rows[0].id]
    );
    console.log(`Default DB admin password initialized: ${DEFAULT_ADMIN_USERNAME}`);
  }

  await pool.query(
    `
      UPDATE users
      SET plan_tier = COALESCE(plan_tier, 'free'),
          plan_status = 'active',
          daily_credit_quota = COALESCE(daily_credit_quota, $1),
          last_credit_reset = COALESCE(last_credit_reset, CURRENT_DATE)
      WHERE id = $2
    `,
    [getPlanConfig('free').monthlyCredits, existing.rows[0].id]
  );
};

const ensureSuperAdminUser = async () => {
  const existing = await pool.query(
    `
      SELECT id, password_hash
      FROM users
      WHERE username = $1
      LIMIT 1
    `,
    [DEFAULT_SADMIN_USERNAME]
  );

  if (!existing.rowCount) {
    const hash = await bcrypt.hash(DEFAULT_SADMIN_PASSWORD, 10);
    const proPlan = getPlanConfig('pro');
    await pool.query(
      `
        INSERT INTO users (
          username, password_hash, email, role, bot_state, credits, plan_tier, plan_status, daily_credit_quota, last_credit_reset
        )
        VALUES ($1, $2, $3, 'admin', 'IDLE', $4, $5, 'active', $4, CURRENT_DATE)
      `,
      [DEFAULT_SADMIN_USERNAME, hash, 'sadmin@example.com', proPlan.monthlyCredits, proPlan.tier]
    );
    console.log(`Default Super DB admin created: ${DEFAULT_SADMIN_USERNAME}`);
    return;
  }

  if (!existing.rows[0].password_hash) {
    const hash = await bcrypt.hash(DEFAULT_SADMIN_PASSWORD, 10);
    await pool.query(
      `
        UPDATE users
        SET password_hash = $1
        WHERE id = $2
      `,
      [hash, existing.rows[0].id]
    );
    console.log(`Default Super DB admin password initialized: ${DEFAULT_SADMIN_USERNAME}`);
  }

  await pool.query(
    `
      UPDATE users
      SET role = 'admin'
      WHERE id = $1
    `,
    [existing.rows[0].id]
  );
};

const sanitizeVideoText = (value, maxLength = 120) =>
  String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/\(file:\/\/[^\s)]+/g, '')
    .trim()
    .slice(0, maxLength);

const isGeminiVideoPlanningEnabled = () => {
  const toggle = String(process.env.VIDEO_GEMINI_MOTION_ENABLED || 'true').trim().toLowerCase();
  if (toggle === 'false' || toggle === '0' || toggle === 'off') {
    return false;
  }
  return Boolean(String(process.env.GEMINI_API_KEY || '').trim());
};

const pickVideoCta = (value) => {
  const normalized = sanitizeVideoText(value, 40);
  const allowed = new Set(['Shop Now', 'Buy Now', 'Learn More', 'Get Offer', 'Order Today']);
  return allowed.has(normalized) ? normalized : '';
};

const normalizeVideoMeta = (meta = {}) => ({
  brandName: sanitizeVideoText(meta?.brandName, 80),
  ctaText: pickVideoCta(meta?.ctaText),
  productName: sanitizeVideoText(meta?.productName, 80),
  visualMood: sanitizeVideoText(meta?.visualMood, 80),
  aspectRatio: sanitizeVideoText(meta?.aspectRatio, 20) || '1:1',
  extraNotes: sanitizeVideoText(meta?.extraNotes, 220),
});

const buildGeminiVideoSummary = (analyzed = {}) => ({
  productName: sanitizeVideoText(analyzed?.productName, 80),
  visualMood: sanitizeVideoText(analyzed?.visualMood, 80),
  mainIngredient: sanitizeVideoText(analyzed?.mainIngredient, 80),
  dynamicElements: sanitizeVideoText(analyzed?.dynamicElements, 120),
  backgroundStyle: sanitizeVideoText(analyzed?.backgroundStyle, 120),
  lightingFocus: sanitizeVideoText(analyzed?.lightingFocus, 40),
  cameraAngle: sanitizeVideoText(analyzed?.cameraAngle, 40),
});

const buildRemotionInstructionSummary = (plan = {}) => ({
  presetSuggestion: sanitizeVideoText(plan?.presetSuggestion, 30),
  cameraMotion: sanitizeVideoText(plan?.cameraMotion, 30),
  motionIntensity: Number.isFinite(Number(plan?.motionIntensity)) ? Number(plan.motionIntensity) : null,
  highlightStyle: sanitizeVideoText(plan?.highlightStyle, 30),
  textStyle: sanitizeVideoText(plan?.textStyle, 30),
  timing: {
    introFrames: Number.isFinite(Number(plan?.timing?.introFrames)) ? Number(plan.timing.introFrames) : null,
    textDelayFrames: Number.isFinite(Number(plan?.timing?.textDelayFrames)) ? Number(plan.timing.textDelayFrames) : null,
    ctaDelayFrames: Number.isFinite(Number(plan?.timing?.ctaDelayFrames)) ? Number(plan.timing.ctaDelayFrames) : null,
  },
  headlineSuggestion: sanitizeVideoText(plan?.headlineSuggestion, 80),
  themeHintsSuggestion: sanitizeVideoText(plan?.themeHintsSuggestion, 100),
});

const isValidVideoImageUrl = (value) => {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return false;
  }
  if (normalized.startsWith('data:image/')) {
    return true;
  }
  if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
    return true;
  }
  return normalized.startsWith('/');
};

const createVideoJobId = () => crypto.randomBytes(12).toString('hex');

const nowIso = () => new Date().toISOString();

const updateVideoJob = (jobId, patch = {}) => {
  const existing = videoRenderJobs.get(jobId);
  if (!existing) {
    return null;
  }
  const next = {
    ...existing,
    ...patch,
    updatedAt: nowIso(),
  };
  videoRenderJobs.set(jobId, next);
  return next;
};

const runVideoRenderProcess = ({ outputPath, inputProps }) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [REMOTION_RENDER_SCRIPT_PATH], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `Video render process failed with code ${code}`));
        return;
      }
      const parsed = safeJsonParse(stdout) || {};
      resolve({
        outputPath: parsed.outputPath || outputPath,
        durationSec: Number(parsed.durationSec || 6),
      });
    });

    child.stdin.end(
      JSON.stringify({
        outputPath,
        inputProps,
      })
    );
  });

const buildGeminiMotionPlanForVideo = async ({ imageUrl }) => {
  const analyzed = await analyzeReferenceImageWithGemini(imageUrl);
  if (!analyzed || typeof analyzed !== 'object') {
    return { analyzed: null, motionPlan: null };
  }
  const motionPlan = buildMotionPlanFromGeminiAnalysis(analyzed);
  return { analyzed, motionPlan };
};

const enqueueVideoRenderJob = ({ userId, imageUrl, presetMode, meta, headline, themeHints, useGeminiMotion }) => {
  const jobId = createVideoJobId();
  const normalizedMeta = normalizeVideoMeta(meta);
  const fallbackPreset = resolveFinalPreset({
    presetMode,
    meta: normalizedMeta,
  });
  const timestamp = Date.now();
  const filename = `${timestamp}-${jobId.slice(0, 8)}.mp4`;
  const outputPath = path.join(VIDEO_OUTPUT_DIR, filename);
  const videoUrl = `/generated-videos/${filename}`;

  const initialRecord = {
    jobId,
    userId: String(userId || ''),
    status: 'queued',
    progress: 5,
    presetMode: String(presetMode || VIDEO_PRESET_MODES.AUTO),
    presetUsed: fallbackPreset,
    videoUrl: '',
    durationSec: null,
    analysisMode: useGeminiMotion ? 'gemini' : 'basic',
    geminiAnalysis: null,
    remotionInstruction: null,
    error: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  videoRenderJobs.set(jobId, initialRecord);

  setImmediate(async () => {
    updateVideoJob(jobId, { status: 'rendering', progress: 14 });
    try {
      let geminiPlan = null;
      let geminiAnalyzed = null;
      const shouldUseGeminiMotion = useGeminiMotion && isGeminiVideoPlanningEnabled();
      if (shouldUseGeminiMotion) {
        try {
          updateVideoJob(jobId, { progress: 28 });
          const geminiResult = await buildGeminiMotionPlanForVideo({ imageUrl });
          geminiPlan = geminiResult.motionPlan;
          geminiAnalyzed = geminiResult.analyzed;
          updateVideoJob(jobId, {
            progress: 40,
            geminiAnalysis: buildGeminiVideoSummary(geminiAnalyzed || {}),
            remotionInstruction: buildRemotionInstructionSummary(geminiPlan || {}),
          });
        } catch (geminiVideoError) {
          logWarn('Video', 'Gemini motion planning failed; using fallback preset', geminiVideoError.message || 'Unknown error');
        }
      }

      const resolvedPreset =
        String(presetMode || '').trim().toLowerCase() === VIDEO_PRESET_MODES.AUTO
          ? (geminiPlan?.presetSuggestion || fallbackPreset)
          : fallbackPreset;

      const inferredHeadline = sanitizeVideoText(geminiPlan?.headlineSuggestion, 80);
      const inferredThemeHints = sanitizeVideoText(geminiPlan?.themeHintsSuggestion, 100);
      const mergedHeadline = sanitizeVideoText(headline, 80) || inferredHeadline || normalizedMeta.productName || 'Product Spotlight';
      const mergedThemeHints = sanitizeVideoText(themeHints, 90) || inferredThemeHints || normalizedMeta.visualMood || '';
      const mergedBrandText = normalizedMeta.brandName || sanitizeVideoText(geminiAnalyzed?.productName, 80);
      const mergedCtaText = normalizedMeta.ctaText;

      updateVideoJob(jobId, {
        progress: 58,
        presetUsed: resolvedPreset,
      });

      const renderResult = await runVideoRenderProcess({
        outputPath,
        inputProps: {
          imageUrl,
          preset: resolvedPreset,
          brandText: mergedBrandText,
          ctaText: mergedCtaText,
          headline: mergedHeadline,
          themeHints: mergedThemeHints,
          motionPlan: geminiPlan || undefined,
        },
      });
      updateVideoJob(jobId, {
        status: 'completed',
        progress: 100,
        videoUrl,
        durationSec: Number(renderResult.durationSec || 6),
        analysisMode: geminiPlan ? 'gemini' : 'basic',
        error: '',
      });
    } catch (error) {
      updateVideoJob(jobId, {
        status: 'failed',
        progress: 100,
        error: sanitizeVideoText(error?.message || 'Video rendering failed', 1200),
      });
    }
  });

  return initialRecord;
};

const cleanupExpiredVideoFiles = () => {
  let removedCount = 0;
  const nowMs = Date.now();
  const entries = fs.readdirSync(VIDEO_OUTPUT_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.mp4')) {
      continue;
    }
    const absolutePath = path.join(VIDEO_OUTPUT_DIR, entry.name);
    const stats = fs.statSync(absolutePath);
    if (nowMs - Number(stats.mtimeMs || 0) > VIDEO_OUTPUT_RETENTION_MS) {
      fs.unlinkSync(absolutePath);
      removedCount += 1;
    }
  }
  if (removedCount > 0) {
    logInfo('Video', 'Cleaned expired videos', `removed=${removedCount}`);
  }
};

const pruneOldVideoJobs = () => {
  const nowMs = Date.now();
  for (const [jobId, job] of videoRenderJobs.entries()) {
    if (!VIDEO_POLLABLE_STATUS.has(job.status)) {
      videoRenderJobs.delete(jobId);
      continue;
    }
    if (job.status === 'completed' || job.status === 'failed') {
      const updatedAtMs = Date.parse(job.updatedAt || '');
      if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > VIDEO_JOB_PRUNE_AGE_MS) {
        videoRenderJobs.delete(jobId);
      }
    }
  }
};

const startVideoLifecycleTasks = () => {
  cleanupExpiredVideoFiles();
  pruneOldVideoJobs();
  if (!videoCleanupIntervalHandle) {
    videoCleanupIntervalHandle = setInterval(() => {
      try {
        cleanupExpiredVideoFiles();
      } catch (error) {
        logWarn('Video', 'Video cleanup failed', error.message || 'Unknown error');
      }
    }, VIDEO_OUTPUT_CLEANUP_INTERVAL_MS);
  }
  if (!videoJobPruneIntervalHandle) {
    videoJobPruneIntervalHandle = setInterval(() => {
      try {
        pruneOldVideoJobs();
      } catch (error) {
        logWarn('Video', 'Video job pruning failed', error.message || 'Unknown error');
      }
    }, VIDEO_JOB_PRUNE_INTERVAL_MS);
  }
};

const stopVideoLifecycleTasks = () => {
  if (videoCleanupIntervalHandle) {
    clearInterval(videoCleanupIntervalHandle);
    videoCleanupIntervalHandle = null;
  }
  if (videoJobPruneIntervalHandle) {
    clearInterval(videoJobPruneIntervalHandle);
    videoJobPruneIntervalHandle = null;
  }
};

app.get('/', (req, res) => {
  if (HAS_STATIC_CLIENT) {
    return res.sendFile(STATIC_INDEX_PATH);
  }
  res.send('AdReady API is running');
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({ ok: true, service: 'adready-api' });
  } catch (error) {
    return res.status(503).json({ ok: false, error: error.message || 'db_unavailable' });
  }
});

app.get('/api/debug', async (req, res) => {
  const result = { db_url_set: Boolean(DATABASE_URL), ssl: PG_SSL_ENABLED };
  try {
    const r = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' LIMIT 10`);
    result.db_connected = true;
    result.tables = r.rows.map((x) => x.table_name);
  } catch (error) {
    result.db_connected = false;
    result.db_error = error.message;
  }
  return res.json(result);
});

app.post('/api/auth/signup', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const emailRaw = String(req.body?.email || '').trim();
  const email = emailRaw.toLowerCase();
  const password = String(req.body?.password || '');

  if (!username || username.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const freePlan = getPlanConfig('free');
    const hash = await bcrypt.hash(password, 10);
    const created = await pool.query(
      `
        INSERT INTO users (
          username, email, password_hash, role, bot_state, credits,
          plan_tier, plan_status, daily_credit_quota, last_credit_reset, last_login_at
        )
        VALUES (
          $1, NULLIF($2, ''), $3, 'member', 'IDLE', $4,
          $5, 'active', $4, CURRENT_DATE, NOW()
        )
        RETURNING *
      `,
      [username, email, hash, freePlan.monthlyCredits, freePlan.tier]
    );

    const user = created.rows[0];
    const token = signAuthToken(user);

    return res.status(201).json({
      token,
      user: buildAuthUserPayload(user),
    });
  } catch (error) {
    if (error?.code === '23505') {
      const detail = String(error?.detail || '').toLowerCase();
      if (detail.includes('username')) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      if (detail.includes('email')) {
        return res.status(409).json({ error: 'Email already exists' });
      }
      return res.status(409).json({ error: 'User already exists' });
    }

    console.error('Signup failed:', error.message);
    return res.status(500).json({ error: 'Signup failed', details: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }

  const bypassAllowedUsername = normalizeAuthUsername(username) === normalizeAuthUsername(DEFAULT_SADMIN_USERNAME);
  const bypassRequested = ALLOW_DEV_AUTH_BYPASS &&
    bypassAllowedUsername &&
    password === DEV_AUTH_BYPASS_PASSWORD;

  if (bypassRequested) {
    try {
      const bypassUser = await ensureDevBypassSuperAdminUser();
      return res.json({
        token: DEV_AUTH_BYPASS_TOKEN,
        user: buildAuthUserPayload(bypassUser),
      });
    } catch (error) {
      console.error('Dev auth bypass failed:', error.message);
      return res.status(500).json({ error: 'Bypass failed', details: error.message });
    }
  }

  try {
    const userResult = await pool.query(
      `
        SELECT *
        FROM users
        WHERE username = $1
          AND is_active = TRUE
        LIMIT 1
      `,
      [username]
    );

    if (!userResult.rowCount) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Password login is not set for this account' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query(
      `
        UPDATE users
        SET last_login_at = NOW()
        WHERE id = $1
      `,
      [user.id]
    );

    const token = signAuthToken(user);
    return res.json({
      token,
      user: buildAuthUserPayload(user),
    });
  } catch (error) {
    console.error('Login failed:', error.message);
    return res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  return res.json({
    user: buildAuthUserPayload(req.user),
  });
});

app.get('/api/billing/plans', requireAuth, async (req, res) => {
  const currentPlanTier = normalizePlanTier(req.user.plan_tier);
  return res.json({
    plans: PLAN_ORDER.map((tier) => {
      const plan = getPlanConfig(tier);
      return {
        tier: plan.tier,
        name: plan.name,
        monthlyCredits: plan.monthlyCredits,
        priceUsdMonthly: plan.priceUsdMonthly,
        isCurrent: tier === currentPlanTier,
      };
    }),
    currentPlan: currentPlanTier,
  });
});

app.post('/api/billing/create-checkout-session', requireAuth, async (req, res) => {
  const requestedPlanTier = normalizePlanTier(req.body?.planTier);
  const plan = getPlanConfig(requestedPlanTier);

  if (isUsageLimitExemptUser(req.user)) {
    return res.status(400).json({ error: 'Admin accounts already have unlimited access' });
  }
  if (requestedPlanTier === 'free') {
    return res.status(400).json({ error: 'Free plan does not require checkout' });
  }
  if (normalizePlanTier(req.user.plan_tier) === requestedPlanTier && String(req.user.plan_status || '').toLowerCase() === 'active') {
    return res.status(400).json({ error: 'This plan is already active on your account' });
  }
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured on server' });
  }
  if (!req.user.email) {
    return res.status(400).json({ error: 'Please set an email in profile before upgrading' });
  }

  try {
    const clientBaseUrl = resolveClientBaseUrl(req);
    if (!clientBaseUrl) {
      return res.status(500).json({ error: 'Client base URL is not configured on server' });
    }
    const successUrl = `${clientBaseUrl.replace(/\/$/, '')}/#/dashboard?billing=success&plan=${plan.tier}&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${clientBaseUrl.replace(/\/$/, '')}/#/dashboard?billing=cancel`;

    const metadata = {
      user_id: req.user.id,
      plan_tier: plan.tier,
      monthly_credit_quota: String(plan.monthlyCredits),
    };

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: req.user.stripe_customer_id || undefined,
      customer_email: req.user.stripe_customer_id ? undefined : req.user.email,
      client_reference_id: req.user.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: Math.round(plan.priceUsdMonthly * 100),
            recurring: { interval: 'month' },
            product_data: {
              name: `AdReady ${plan.name} Plan`,
              description: `${plan.monthlyCredits} credits per month`,
            },
          },
        },
      ],
      metadata,
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    if (checkoutSession.customer && !req.user.stripe_customer_id) {
      await pool.query(
        `
          UPDATE users
          SET stripe_customer_id = $1
          WHERE id = $2
        `,
        [String(checkoutSession.customer), req.user.id]
      );
    }

    return res.json({
      url: checkoutSession.url,
      sessionId: checkoutSession.id,
    });
  } catch (error) {
    console.error('Create checkout session failed:', error.message);
    return res.status(500).json({ error: 'Failed to create checkout session', details: error.message });
  }
});

app.post('/api/billing/confirm-session', requireAuth, async (req, res) => {
  const sessionId = String(req.body?.sessionId || '').trim();

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured on server' });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (!checkoutSession) {
      return res.status(404).json({ error: 'Checkout session not found' });
    }

    const metadata = checkoutSession.metadata || {};
    const paid =
      String(checkoutSession.payment_status || '').toLowerCase() === 'paid' ||
      String(checkoutSession.status || '').toLowerCase() === 'complete';
    if (!paid) {
      return res.status(409).json({ error: 'Payment is not completed yet' });
    }

    const ownerUserId = String(metadata.user_id || checkoutSession.client_reference_id || '').trim();
    if (!ownerUserId || ownerUserId !== String(req.user.id)) {
      return res.status(403).json({ error: 'This checkout session does not belong to the current user' });
    }

    const planTier = normalizePlanTier(metadata.plan_tier);
    if (planTier === 'free') {
      return res.status(400).json({ error: 'Invalid plan in checkout metadata' });
    }

    const updatedUser = await applyPlanToUser({
      userId: req.user.id,
      planTier,
      stripeCustomerId: checkoutSession.customer ? String(checkoutSession.customer) : null,
      stripeSubscriptionId: checkoutSession.subscription ? String(checkoutSession.subscription) : null,
    });
    if (!updatedUser) {
      return res.status(404).json({ error: 'User not found for plan activation' });
    }

    return res.json({
      ok: true,
      user: buildAuthUserPayload(updatedUser),
      source: 'checkout_confirm',
      sessionId,
      planTier: normalizePlanTier(updatedUser.plan_tier),
      credits: Number(updatedUser.credits || 0),
    });
  } catch (error) {
    console.error('Confirm checkout session failed:', error.message);
    return res.status(500).json({ error: 'Failed to confirm checkout session', details: error.message });
  }
});

app.get('/api/admin/stats', requireSuperAdmin, async (req, res) => {
  try {
    const usersCountRes = await pool.query(`SELECT COUNT(*) as count FROM users`);
    const totalUsers = parseInt(usersCountRes.rows[0].count, 10);

    let totalGeneratedImages = 0;
    let pendingGenerations = 0;
    let failedGenerations = 0;

    try {
      const generationStatsRes = await pool.query(
        `
          SELECT
            COUNT(*) FILTER (WHERE status = 'succeeded')::int AS total_generated_images,
            COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS pending_generations,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_generations
          FROM generation_runs
        `
      );
      totalGeneratedImages = Number(generationStatsRes.rows[0]?.total_generated_images || 0);
      pendingGenerations = Number(generationStatsRes.rows[0]?.pending_generations || 0);
      failedGenerations = Number(generationStatsRes.rows[0]?.failed_generations || 0);
    } catch (generationError) {
      if (generationError?.code !== '42P01') {
        throw generationError;
      }
      // If generation_runs table is not present yet, keep zero counters.
    }

    return res.json({
      totalUsers,
      totalGeneratedImages,
      pendingGenerations,
      failedGenerations,
      // Backward-compatible aliases for old frontend keys.
      totalPosts: totalGeneratedImages,
      pendingPosts: pendingGenerations,
      failedPosts: failedGenerations,
      dbStatus: 'Connected',
    });
  } catch (error) {
    console.error('Failed to fetch admin stats:', error);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

app.get('/api/admin/system/diagnostics', requireSuperAdmin, async (req, res) => {
  const diagnostics = {
    runtime: {
      isVercelRuntime: IS_VERCEL_RUNTIME,
      isServerlessRuntime: IS_SERVERLESS_RUNTIME,
      telegramModeConfigured: String(process.env.TELEGRAM_MODE || 'polling').toLowerCase(),
      telegramWebhookPath: normalizeWebhookPath(process.env.TELEGRAM_WEBHOOK_PATH || '/webhook'),
      paymentWebhookPaths: Array.from(PAYMENT_WEBHOOK_PATHS),
    },
    database: {
      connected: false,
      missingTables: [],
      tables: {},
    },
  };

  try {
    await pool.query('SELECT 1');
    diagnostics.database.connected = true;

    const tableProbe = await pool.query(
      `
        SELECT
          to_regclass('public.users') AS users,
          to_regclass('public.plan_settings') AS plan_settings,
          to_regclass('public.integration_settings') AS integration_settings,
          to_regclass('public.projects') AS projects,
          to_regclass('public.project_api_keys') AS project_api_keys
      `
    );
    const tableRow = tableProbe.rows[0] || {};
    for (const [key, value] of Object.entries(tableRow)) {
      const exists = Boolean(value);
      diagnostics.database.tables[key] = exists;
      if (!exists) diagnostics.database.missingTables.push(key);
    }

    if (diagnostics.database.tables.integration_settings) {
      const integrationRows = await pool.query(
        `
          SELECT provider, is_enabled, updated_at
          FROM integration_settings
          ORDER BY provider ASC
        `
      );
      diagnostics.runtime.integrationSettings = integrationRows.rows.map((row) => ({
        provider: String(row.provider || '').toLowerCase(),
        isEnabled: row.is_enabled !== false,
        updatedAt: row.updated_at || null,
      }));
    } else {
      diagnostics.runtime.integrationSettings = [];
    }

    return res.json({
      ok: diagnostics.database.missingTables.length === 0,
      diagnostics,
    });
  } catch (error) {
    console.error('Failed to build admin diagnostics:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'Failed to build diagnostics',
      details: error.message,
      diagnostics,
    });
  }
});

app.get('/api/admin/users', requireSuperAdmin, async (req, res) => {
  try {
    const usersRes = await pool.query(
      `SELECT id, username, email, role, plan_tier, credits, daily_credit_quota, is_active, last_login_at, created_at,
              COALESCE(NULLIF(TRIM(bot_data->>'phone'), ''), NULL) AS phone,
              CASE
                WHEN LOWER(username) = LOWER($1) AND role = 'admin' THEN TRUE
                ELSE FALSE
              END AS is_super_admin
       FROM users
       ORDER BY id ASC`
      ,
      [DEFAULT_SADMIN_USERNAME]
    );
    const users = usersRes.rows.map(u => ({
      ...u,
      joined_at: u.created_at || u.last_login_at || null
    }));
    return res.json({ users });
  } catch (error) {
    console.error('Failed to fetch admin users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.get('/api/admin/history', requireSuperAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `
        SELECT
          req.created_by_user_id::text AS user_id,
          COALESCE(NULLIF(TRIM(u.username), ''), 'Unknown User') AS username,
          DATE_TRUNC('minute', COALESCE(gr.finished_at, gr.created_at)) AS event_time,
          COUNT(*)::int AS generated_count
        FROM generation_runs gr
        JOIN generation_requests req ON req.id = gr.request_id
        LEFT JOIN users u ON u.id = req.created_by_user_id
        WHERE gr.status = 'succeeded'
        GROUP BY
          req.created_by_user_id,
          COALESCE(NULLIF(TRIM(u.username), ''), 'Unknown User'),
          DATE_TRUNC('minute', COALESCE(gr.finished_at, gr.created_at))
        ORDER BY event_time DESC
        LIMIT 200
      `
    );

    const history = result.rows.map((row) => ({
      userId: row.user_id || null,
      username: String(row.username || 'Unknown User'),
      generatedCount: Number(row.generated_count || 0),
      eventTime: row.event_time || null,
    }));

    return res.json({ history });
  } catch (error) {
    if (error?.code === '42P01') {
      return res.json({ history: [] });
    }
    console.error('Failed to fetch admin history:', error);
    return res.status(500).json({ error: 'Failed to fetch history' });
  }
});

app.get('/api/admin/api-logs', requireSuperAdmin, async (req, res) => {
  const requestedLimit = Number(req.query?.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(300, Math.floor(requestedLimit)))
    : 100;
  const levelFilter = String(req.query?.level || 'all').trim().toLowerCase();
  const projectIdFilter = String(req.query?.projectId || '').trim();

  if (levelFilter !== 'all' && !PROJECT_API_LOG_LEVELS.has(levelFilter)) {
    return res.status(400).json({ error: 'Invalid level filter. Use all, info, or error.' });
  }

  try {
    await ensureProjectApiLogsTable({ force: true });
    const whereClauses = [];
    const params = [];
    let paramIndex = 1;

    if (levelFilter !== 'all') {
      whereClauses.push(`level = $${paramIndex}`);
      params.push(levelFilter);
      paramIndex += 1;
    }
    if (projectIdFilter) {
      whereClauses.push(`project_id::text = $${paramIndex}`);
      params.push(projectIdFilter);
      paramIndex += 1;
    }

    params.push(limit);
    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const result = await pool.query(
      `
        SELECT
          id::text AS id,
          project_id::text AS project_id,
          project_name,
          method,
          endpoint_path,
          source,
          status_code,
          level,
          latency_ms,
          request_preview,
          response_preview,
          error_text,
          created_at
        FROM project_api_logs
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${paramIndex}
      `,
      params
    );

    const logs = result.rows.map((row) => ({
      id: String(row.id || ''),
      createdAt: row.created_at || null,
      projectId: row.project_id ? String(row.project_id) : null,
      projectName: row.project_name ? String(row.project_name) : null,
      method: String(row.method || 'POST').toUpperCase(),
      endpointPath: String(row.endpoint_path || PROJECT_API_EXTERNAL_GENERATE_PATH),
      source: row.source ? String(row.source) : null,
      statusCode: Number.isFinite(Number(row.status_code)) ? Number(row.status_code) : null,
      level: PROJECT_API_LOG_LEVELS.has(String(row.level || '').toLowerCase())
        ? String(row.level).toLowerCase()
        : 'info',
      latencyMs: Number.isFinite(Number(row.latency_ms)) ? Number(row.latency_ms) : null,
      requestPreview: row.request_preview && typeof row.request_preview === 'object' ? row.request_preview : {},
      responsePreview: row.response_preview && typeof row.response_preview === 'object' ? row.response_preview : {},
      errorText: row.error_text ? String(row.error_text) : null,
    }));

    return res.json({
      logs,
      retentionDays: PROJECT_API_LOG_RETENTION_DAYS,
    });
  } catch (error) {
    if (error?.code === '42P01') {
      return res.json({ logs: [], retentionDays: PROJECT_API_LOG_RETENTION_DAYS });
    }
    console.error('Failed to fetch admin api logs:', error);
    return res.status(500).json({ error: 'Failed to fetch API logs' });
  }
});

app.get('/api/admin/plans', requireSuperAdmin, async (req, res) => {
  try {
    await ensurePlanSettingsTable();
    const result = await pool.query(
      `
        SELECT tier, name, price_usd_monthly, monthly_credits, is_editable
        FROM plan_settings
        ORDER BY CASE tier
          WHEN 'free' THEN 1
          WHEN 'basic' THEN 2
          WHEN 'pro' THEN 3
          ELSE 4
        END
      `
    );

    if (!result.rowCount) {
      const fallbackPlans = getOrderedPlanConfigs().map((plan) => ({
        tier: plan.tier,
        name: plan.name,
        priceUsdMonthly: plan.priceUsdMonthly,
        monthlyCredits: plan.monthlyCredits,
        isEditable: true,
      }));
      return res.json({ plans: fallbackPlans });
    }

    const plans = result.rows.map((row) => ({
      tier: normalizePlanTier(row.tier),
      name: String(row.name || ''),
      priceUsdMonthly: Number(row.price_usd_monthly || 0),
      monthlyCredits: Number(row.monthly_credits || 0),
      isEditable: row.is_editable !== false,
    }));

    return res.json({ plans });
  } catch (error) {
    console.error('Failed to fetch admin plans:', error);
    return res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

app.put('/api/admin/plans/:tier', requireSuperAdmin, async (req, res) => {
  const tier = normalizePlanTier(req.params?.tier);
  const name = String(req.body?.name || '').trim();
  const priceRaw = Number(req.body?.priceUsdMonthly);
  const creditsRaw = Number(req.body?.monthlyCredits);

  if (!PLAN_ORDER.includes(tier)) {
    return res.status(400).json({ error: 'Invalid plan tier' });
  }
  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Plan name must be at least 2 characters' });
  }
  if (!Number.isFinite(priceRaw) || priceRaw < 0) {
    return res.status(400).json({ error: 'Price must be a non-negative number' });
  }
  if (!Number.isFinite(creditsRaw) || creditsRaw < 0) {
    return res.status(400).json({ error: 'Monthly credits must be a non-negative number' });
  }

  try {
    await ensurePlanSettingsTable();
    await pool.query(
      `
        INSERT INTO plan_settings (tier, name, price_usd_monthly, monthly_credits, is_editable)
        VALUES ($4, $1, $2, $3, TRUE)
        ON CONFLICT (tier)
        DO UPDATE SET
          name = EXCLUDED.name,
          price_usd_monthly = EXCLUDED.price_usd_monthly,
          monthly_credits = EXCLUDED.monthly_credits,
          updated_at = NOW()
      `,
      [name, Number(priceRaw.toFixed(2)), Math.floor(creditsRaw), tier]
    );

    await loadPlanDefinitionsFromDb();
    const plan = getPlanConfig(tier);

    return res.json({
      ok: true,
      plan: {
        tier,
        name: plan.name,
        priceUsdMonthly: Number(plan.priceUsdMonthly),
        monthlyCredits: Number(plan.monthlyCredits),
      },
    });
  } catch (error) {
    console.error('Failed to update admin plan:', error);
    return res.status(500).json({ error: 'Failed to update plan' });
  }
});

app.get('/api/admin/topups', requireSuperAdmin, async (req, res) => {
  try {
    await syncTopupPackages({ force: true });
    const topups = getOrderedTopupPackages().map((pack) => ({
      credits: Number(pack.credits || 0),
      priceUsd: Number(pack.priceUsd || 0),
      isActive: pack.isActive !== false,
      sortOrder: Number(pack.sortOrder || 0),
    }));
    return res.json({ topups });
  } catch (error) {
    if (error?.code === '42P01') {
      TOPUP_PACK_DEFINITIONS = JSON.parse(JSON.stringify(DEFAULT_TOPUP_PACK_DEFINITIONS));
      const topups = sortTopupPackages(DEFAULT_TOPUP_PACK_DEFINITIONS).map((pack) => ({
        credits: Number(pack.credits || 0),
        priceUsd: Number(pack.priceUsd || 0),
        isActive: pack.isActive !== false,
        sortOrder: Number(pack.sortOrder || 0),
      }));
      return res.json({ topups });
    }
    console.error('Failed to fetch admin topups:', error);
    return res.status(500).json({ error: 'Failed to fetch top-up packages' });
  }
});

app.put('/api/admin/topups', requireSuperAdmin, async (req, res) => {
  const topups = Array.isArray(req.body?.topups) ? req.body.topups : [];
  if (!topups.length) {
    return res.status(400).json({ error: 'At least one top-up package is required' });
  }

  const normalized = topups.map((item, index) =>
    normalizeTopupPackageDraft(
      {
        credits: item?.credits,
        priceUsd: item?.priceUsd,
        isActive: item?.isActive,
        sortOrder: item?.sortOrder,
      },
      index + 1
    )
  );

  const seenCredits = new Set();
  let hasActive = false;
  for (const pack of normalized) {
    if (!Number.isFinite(pack.credits) || pack.credits <= 0) {
      return res.status(400).json({ error: 'Each package credits value must be a positive number' });
    }
    if (!Number.isFinite(pack.priceUsd) || pack.priceUsd < 0) {
      return res.status(400).json({ error: 'Each package price must be a non-negative number' });
    }
    if (seenCredits.has(pack.credits)) {
      return res.status(400).json({ error: `Duplicate credits value found: ${pack.credits}` });
    }
    seenCredits.add(pack.credits);
    if (pack.isActive !== false) {
      hasActive = true;
    }
  }

  if (!hasActive) {
    return res.status(400).json({ error: 'At least one active top-up package is required' });
  }

  const client = await pool.connect();
  try {
    await ensureTopupPackagesTable({ force: true });
    await client.query('BEGIN');
    await client.query(`DELETE FROM topup_packages`);
    for (const pack of normalized) {
      await client.query(
        `
          INSERT INTO topup_packages (credits, price_usd, is_active, sort_order, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
        `,
        [pack.credits, Number(pack.priceUsd.toFixed(2)), pack.isActive !== false, pack.sortOrder]
      );
    }
    await client.query('COMMIT');
    await syncTopupPackages({ force: true });

    const savedTopups = getOrderedTopupPackages().map((pack) => ({
      credits: Number(pack.credits || 0),
      priceUsd: Number(pack.priceUsd || 0),
      isActive: pack.isActive !== false,
      sortOrder: Number(pack.sortOrder || 0),
    }));
    return res.json({ ok: true, topups: savedTopups });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Failed to update admin topups:', error);
    if (error?.code === '42P01') {
      return res.status(500).json({
        error: 'Top-up table is missing. Run latest DB migration or enable table create permissions.',
      });
    }
    return res.status(500).json({ error: 'Failed to update top-up packages' });
  } finally {
    client.release();
  }
});

app.delete('/api/admin/topups/:credits', requireSuperAdmin, async (req, res) => {
  const credits = Math.floor(Number(req.params?.credits));
  if (!Number.isFinite(credits) || credits <= 0) {
    return res.status(400).json({ error: 'Invalid credits value' });
  }

  const client = await pool.connect();
  let inTransaction = false;
  try {
    await ensureTopupPackagesTable({ force: true });

    const existingResult = await client.query(
      `
        SELECT credits
        FROM topup_packages
        WHERE credits = $1
        LIMIT 1
      `,
      [credits]
    );
    if (!existingResult.rowCount) {
      await syncTopupPackages({ force: true });
      return res.status(404).json({ error: 'Top-up package not found' });
    }

    const countResult = await client.query(`SELECT COUNT(*)::int AS total FROM topup_packages`);
    const total = Number(countResult.rows?.[0]?.total || 0);
    if (total <= 1) {
      return res.status(400).json({ error: 'At least one top-up package is required' });
    }

    await client.query('BEGIN');
    inTransaction = true;
    await client.query(`DELETE FROM topup_packages WHERE credits = $1`, [credits]);
    await client.query('COMMIT');
    inTransaction = false;
    await syncTopupPackages({ force: true });

    const topups = getOrderedTopupPackages().map((pack) => ({
      credits: Number(pack.credits || 0),
      priceUsd: Number(pack.priceUsd || 0),
      isActive: pack.isActive !== false,
      sortOrder: Number(pack.sortOrder || 0),
    }));
    return res.json({ ok: true, topups });
  } catch (error) {
    if (inTransaction) {
      await client.query('ROLLBACK');
    }
    console.error('Failed to delete admin topup:', error);
    return res.status(500).json({ error: 'Failed to delete top-up package' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/connections', requireSuperAdmin, async (req, res) => {
  try {
    await ensureIntegrationSettingsTable();
    await seedIntegrationSettingsDefaults();

    const result = await pool.query(
      `
        SELECT provider, is_enabled, config, updated_at
        FROM integration_settings
        ORDER BY CASE provider
          WHEN 'telegram' THEN 1
          WHEN 'stripe' THEN 2
          WHEN 'openai' THEN 3
          WHEN 'gemini' THEN 4
          WHEN 'smtp' THEN 5
          ELSE 99
        END
      `
    );

    const rowsByProvider = {};
    for (const row of result.rows) {
      rowsByProvider[row.provider] = row;
    }

    const connections = CONNECTION_PROVIDER_ORDER.map((provider) => {
      const row = rowsByProvider[provider];
      if (!row) {
        const fallback = buildDefaultConnectionRow(provider);
        return {
          provider,
          isEnabled: fallback.isEnabled,
          config: fallback.config,
          updatedAt: null,
        };
      }
      const mergedConfig = {
        ...buildDefaultConnectionConfig(provider),
        ...(row.config && typeof row.config === 'object' ? row.config : {}),
      };
      return {
        provider,
        isEnabled: row.is_enabled !== false,
        config: mergedConfig,
        updatedAt: row.updated_at || null,
      };
    });

    return res.json({ connections });
  } catch (error) {
    console.error('Failed to fetch admin connections:', error);
    return res.status(500).json({ error: 'Failed to fetch connections' });
  }
});

app.put('/api/admin/connections/:provider', requireSuperAdmin, async (req, res) => {
  const provider = String(req.params?.provider || '').trim().toLowerCase();
  if (!CONNECTION_PROVIDER_ORDER.includes(provider)) {
    return res.status(400).json({ error: 'Invalid connection provider' });
  }

  const requestedTelegramMode = provider === 'telegram'
    ? String(req.body?.config?.mode || '').trim().toLowerCase()
    : '';
  const isEnabled = req.body?.isEnabled === true;
  const incomingConfig = sanitizeConnectionConfig(provider, req.body?.config);

  try {
    await ensureIntegrationSettingsTable();
    await seedIntegrationSettingsDefaults();

    const existing = await pool.query(
      `
        SELECT config
        FROM integration_settings
        WHERE provider = $1
        LIMIT 1
      `,
      [provider]
    );
    const currentConfig = existing.rowCount && existing.rows[0]?.config && typeof existing.rows[0].config === 'object'
      ? existing.rows[0].config
      : {};

    const mergedConfig = {
      ...buildDefaultConnectionConfig(provider),
      ...currentConfig,
      ...incomingConfig,
    };

    const updated = await pool.query(
      `
        INSERT INTO integration_settings (provider, is_enabled, config)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (provider)
        DO UPDATE SET
          is_enabled = EXCLUDED.is_enabled,
          config = EXCLUDED.config,
          updated_at = NOW()
        RETURNING provider, is_enabled, config, updated_at
      `,
      [provider, isEnabled, JSON.stringify(mergedConfig)]
    );

    const row = updated.rows[0];
    const runtimeRow = buildConnectionRuntimeRow(provider, row);
    applyConnectionRuntimeEnv(provider, runtimeRow);
    const runtimeNotes = [];
    if (provider === 'stripe') {
      refreshStripeRuntimeFromEnv();
    } else if (provider === 'openai') {
      refreshOpenAiRuntimeFromEnv();
    } else if (provider === 'smtp') {
      refreshSmtpRuntimeFromEnv();
    } else if (provider === 'telegram') {
      if (IS_SERVERLESS_RUNTIME && requestedTelegramMode === 'polling') {
        runtimeNotes.push('Serverless runtime detected: Telegram mode was automatically set to webhook.');
      }
      // Restart Telegram runtime in background so admin save API does not hang
      // when bot launch/polling takes too long.
      startTelegramRuntime({ restart: true }).catch((runtimeError) => {
        console.error('Telegram runtime restart failed after saving settings:', runtimeError);
      });
    }

    return res.json({
      ok: true,
      connection: {
        provider: row.provider,
        isEnabled: row.is_enabled !== false,
        config: row.config && typeof row.config === 'object' ? row.config : {},
        updatedAt: row.updated_at || null,
      },
      note: runtimeNotes.length
        ? `Connection settings saved and applied. ${runtimeNotes.join(' ')}`
        : 'Connection settings saved and applied.',
    });
  } catch (error) {
    console.error('Failed to update admin connection:', error);
    return res.status(500).json({ error: 'Failed to update connection' });
  }
});

app.post('/api/admin/projects', requireSuperAdmin, async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();

  if (!name || name.length < 2) {
    return res.status(400).json({ error: 'Project name must be at least 2 characters' });
  }
  if (name.length > 120) {
    return res.status(400).json({ error: 'Project name cannot exceed 120 characters' });
  }

  try {
    const created = await pool.query(
      `
        INSERT INTO projects (owner_user_id, name, description, status)
        VALUES ($1, $2, NULLIF($3, ''), 'active')
        RETURNING
          id::text AS id,
          name,
          status::text AS status,
          owner_user_id::text AS owner_user_id,
          created_at,
          updated_at
      `,
      [req.user.id, name, description]
    );
    const row = created.rows[0];
    return res.status(201).json({
      ok: true,
      project: {
        id: String(row.id || ''),
        name: String(row.name || ''),
        status: String(row.status || 'active'),
        ownerUserId: String(row.owner_user_id || req.user.id),
        createdAt: row.created_at || null,
        updatedAt: row.updated_at || null,
        sourceType: 'manual',
        telegramId: null,
        telegramBotUsername: null,
      },
    });
  } catch (error) {
    if (error?.code === '22001') {
      return res.status(400).json({ error: 'Project name is too long' });
    }
    console.error('Failed to create admin project:', error);
    return res.status(500).json({ error: 'Failed to create project' });
  }
});

app.delete('/api/admin/projects/:projectId', requireSuperAdmin, async (req, res) => {
  const projectId = String(req.params?.projectId || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    const deleted = await pool.query(
      `
        DELETE FROM projects
        WHERE id = $1
        RETURNING id::text AS id, name
      `,
      [projectId]
    );
    if (!deleted.rowCount) {
      return res.status(404).json({ error: 'Project not found' });
    }

    return res.json({
      ok: true,
      project: {
        id: String(deleted.rows[0].id || ''),
        name: String(deleted.rows[0].name || ''),
      },
      note: 'Project deleted successfully.',
    });
  } catch (error) {
    if (error?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid projectId format' });
    }
    console.error('Failed to delete project:', error);
    return res.status(500).json({ error: 'Failed to delete project', details: error.message });
  }
});

app.get('/api/admin/project-apis', requireSuperAdmin, async (req, res) => {
  try {
    await ensureProjectApiKeysTable({ force: true });
    await ensureProjectApiPipelineTables({ force: true });
    const projectsResult = await pool.query(
      `
        SELECT
          id,
          name,
          status::text AS status,
          owner_user_id::text AS owner_user_id,
          created_at,
          updated_at
        FROM projects
        ORDER BY created_at DESC
      `
    );
    const projectIds = projectsResult.rows.map((row) => String(row.id || '').trim()).filter(Boolean);
    const projectContext = await getTelegramProjectContext(projectIds);
    const runtimeSettings = await getProjectApiRuntimeSettings();

    const projects = projectsResult.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name || ''),
      status: row.status ? String(row.status) : null,
      ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
      createdAt: row.created_at || null,
      updatedAt: row.updated_at || null,
      sourceType: projectContext.contextByProjectId[String(row.id)]?.telegramId ? 'telegram' : 'manual',
      telegramId: projectContext.contextByProjectId[String(row.id)]?.telegramId || null,
      telegramBotUsername: projectContext.contextByProjectId[String(row.id)]?.telegramBotUsername || null,
    }));
    let apis = [];
    try {
      const projectApiResult = await pool.query(
        `
          SELECT
            pak.project_id::text AS project_id,
            p.name AS project_name,
            p.status::text AS project_status,
            p.owner_user_id::text AS owner_user_id,
            pak.key_prefix,
            pak.key_last4,
            pak.is_enabled,
            pak.created_by_user_id::text AS created_by_user_id,
            pak.rotated_at,
            pak.last_used_at,
            pak.created_at,
            pak.updated_at
          FROM project_api_keys pak
          JOIN projects p ON p.id = pak.project_id
          ORDER BY COALESCE(pak.updated_at, pak.created_at) DESC
        `
      );
      apis = projectApiResult.rows.map((row) => {
        const mapped = mapProjectApiAdminRow(row);
        const context = projectContext.contextByProjectId[mapped.projectId];
        if (context?.telegramId) {
          return {
            ...mapped,
            sourceType: 'telegram',
            telegramId: context.telegramId,
            telegramBotUsername: context.telegramBotUsername || null,
          };
        }
        return {
          ...mapped,
          sourceType: 'manual',
          telegramId: null,
          telegramBotUsername: null,
        };
      });
    } catch (apiTableError) {
      if (apiTableError?.code !== '42P01') {
        throw apiTableError;
      }
      apis = [];
    }

    let policies = [];
    try {
      if (projectIds.length) {
        const policyResult = await pool.query(
          `
            SELECT
              project_id,
              default_generate_pipeline,
              allowed_generate_pipelines,
              allow_generate_override,
              default_analyze_pipeline,
              allowed_analyze_pipelines,
              allow_analyze_override,
              created_at,
              updated_at
            FROM project_api_pipeline_policies
            WHERE project_id = ANY($1::uuid[])
          `,
          [projectIds]
        );
        const policyByProjectId = {};
        for (const row of policyResult.rows) {
          const normalized = normalizeProjectApiPipelinePolicyRow(row);
          if (normalized.projectId) {
            policyByProjectId[normalized.projectId] = normalized;
          }
        }
        policies = projectIds.map((projectId) => {
          const existing = policyByProjectId[projectId];
          if (existing) return existing;
          return {
            ...normalizeProjectApiPipelinePolicyRow({ project_id: projectId }),
            projectId,
          };
        });
      } else {
        policies = [];
      }
    } catch (policyTableError) {
      if (policyTableError?.code !== '42P01') {
        throw policyTableError;
      }
      policies = projectIds.map((projectId) => ({
        ...normalizeProjectApiPipelinePolicyRow({ project_id: projectId }),
        projectId,
      }));
    }

    return res.json({
      projects,
      apis,
      policies,
      runtimeSettings,
      sharedEndpointPath: PROJECT_API_EXTERNAL_GENERATE_PATH,
      sharedEndpointUrl: buildProjectExternalEndpointUrl(req),
      sharedAnalyzeEndpointPath: PROJECT_API_EXTERNAL_ANALYZE_PATH,
      sharedAnalyzeEndpointUrl: buildProjectExternalAnalyzeEndpointUrl(req),
      pipelineCatalog: {
        generate: cloneStringList(PROJECT_API_GENERATE_PIPELINES),
        analyze: cloneStringList(PROJECT_API_ANALYZE_PIPELINES),
      },
    });
  } catch (error) {
    console.error('Failed to fetch admin project APIs:', error);
    return res.status(500).json({ error: 'Failed to fetch project APIs', details: error.message });
  }
});

app.post('/api/admin/project-apis', requireSuperAdmin, async (req, res) => {
  const projectId = String(req.body?.projectId || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    await ensureProjectApiKeysTable({ force: true });
    const projectResult = await pool.query(
      `
        SELECT id
        FROM projects
        WHERE id = $1
        LIMIT 1
      `,
      [projectId]
    );
    if (!projectResult.rowCount) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await ensureProjectApiPipelinePolicyRow(projectId);

    const plaintextApiKey = generateProjectApiKey();
    const insertResult = await pool.query(
      `
        INSERT INTO project_api_keys (
          project_id,
          api_key_hash,
          api_key_encrypted,
          key_prefix,
          key_last4,
          is_enabled,
          created_by_user_id,
          rotated_at
        )
        VALUES ($1, $2, $3, $4, $5, TRUE, $6, NOW())
        ON CONFLICT (project_id) DO NOTHING
        RETURNING project_id
      `,
      [
        projectId,
        hashProjectApiKey(plaintextApiKey),
        encryptProjectApiKey(plaintextApiKey),
        getProjectApiKeyPrefix(plaintextApiKey),
        getProjectApiKeyLast4(plaintextApiKey),
        req.user.id,
      ]
    );
    if (!insertResult.rowCount) {
      return res.status(409).json({ error: 'This project already has an API key. Use regenerate instead.' });
    }

    const rowResult = await pool.query(
      `
        SELECT
          pak.project_id::text AS project_id,
          p.name AS project_name,
          p.status::text AS project_status,
          p.owner_user_id::text AS owner_user_id,
          pak.key_prefix,
          pak.key_last4,
          pak.is_enabled,
          pak.created_by_user_id::text AS created_by_user_id,
          pak.rotated_at,
          pak.last_used_at,
          pak.created_at,
          pak.updated_at
        FROM project_api_keys pak
        JOIN projects p ON p.id = pak.project_id
        WHERE pak.project_id = $1
        LIMIT 1
      `,
      [projectId]
    );
    if (!rowResult.rowCount) {
      return res.status(500).json({ error: 'Failed to load created API key row' });
    }
    const projectContext = await getTelegramProjectContext([projectId]);
    const mapped = mapProjectApiAdminRow(rowResult.rows[0]);
    const context = projectContext.contextByProjectId[mapped.projectId];

    return res.status(201).json({
      ok: true,
      api: {
        ...mapped,
        sourceType: context?.telegramId ? 'telegram' : 'manual',
        telegramId: context?.telegramId || null,
        telegramBotUsername: context?.telegramBotUsername || null,
      },
      apiKey: plaintextApiKey,
      sharedEndpointPath: PROJECT_API_EXTERNAL_GENERATE_PATH,
      sharedEndpointUrl: buildProjectExternalEndpointUrl(req),
      sharedAnalyzeEndpointPath: PROJECT_API_EXTERNAL_ANALYZE_PATH,
      sharedAnalyzeEndpointUrl: buildProjectExternalAnalyzeEndpointUrl(req),
    });
  } catch (error) {
    if (error?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid projectId format' });
    }
    console.error('Failed to create project API key:', error);
    return res.status(500).json({ error: 'Failed to create project API key', details: error.message });
  }
});

app.post('/api/admin/project-apis/:projectId/regenerate', requireSuperAdmin, async (req, res) => {
  const projectId = String(req.params?.projectId || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    await ensureProjectApiKeysTable({ force: true });
    await ensureProjectApiPipelineTables({ force: true });
    await ensureProjectApiPipelinePolicyRow(projectId);
    const plaintextApiKey = generateProjectApiKey();
    const updatedResult = await pool.query(
      `
        UPDATE project_api_keys
        SET api_key_hash = $2,
            api_key_encrypted = $3,
            key_prefix = $4,
            key_last4 = $5,
            created_by_user_id = $6,
            rotated_at = NOW(),
            updated_at = NOW()
        WHERE project_id = $1
        RETURNING project_id
      `,
      [
        projectId,
        hashProjectApiKey(plaintextApiKey),
        encryptProjectApiKey(plaintextApiKey),
        getProjectApiKeyPrefix(plaintextApiKey),
        getProjectApiKeyLast4(plaintextApiKey),
        req.user.id,
      ]
    );
    if (!updatedResult.rowCount) {
      return res.status(404).json({ error: 'Project API key not found' });
    }

    const rowResult = await pool.query(
      `
        SELECT
          pak.project_id::text AS project_id,
          p.name AS project_name,
          p.status::text AS project_status,
          p.owner_user_id::text AS owner_user_id,
          pak.key_prefix,
          pak.key_last4,
          pak.is_enabled,
          pak.created_by_user_id::text AS created_by_user_id,
          pak.rotated_at,
          pak.last_used_at,
          pak.created_at,
          pak.updated_at
        FROM project_api_keys pak
        JOIN projects p ON p.id = pak.project_id
        WHERE pak.project_id = $1
        LIMIT 1
      `,
      [projectId]
    );
    if (!rowResult.rowCount) {
      return res.status(500).json({ error: 'Failed to load regenerated API key row' });
    }
    const projectContext = await getTelegramProjectContext([projectId]);
    const mapped = mapProjectApiAdminRow(rowResult.rows[0]);
    const context = projectContext.contextByProjectId[mapped.projectId];

    return res.json({
      ok: true,
      api: {
        ...mapped,
        sourceType: context?.telegramId ? 'telegram' : 'manual',
        telegramId: context?.telegramId || null,
        telegramBotUsername: context?.telegramBotUsername || null,
      },
      apiKey: plaintextApiKey,
    });
  } catch (error) {
    if (error?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid projectId format' });
    }
    console.error('Failed to regenerate project API key:', error);
    return res.status(500).json({ error: 'Failed to regenerate project API key', details: error.message });
  }
});

app.patch('/api/admin/project-apis/:projectId/status', requireSuperAdmin, async (req, res) => {
  const projectId = String(req.params?.projectId || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }
  if (typeof req.body?.isEnabled !== 'boolean') {
    return res.status(400).json({ error: 'isEnabled must be a boolean' });
  }

  try {
    await ensureProjectApiKeysTable({ force: true });
    const updatedResult = await pool.query(
      `
        UPDATE project_api_keys
        SET is_enabled = $2,
            updated_at = NOW()
        WHERE project_id = $1
        RETURNING project_id
      `,
      [projectId, req.body.isEnabled]
    );
    if (!updatedResult.rowCount) {
      return res.status(404).json({ error: 'Project API key not found' });
    }

    const rowResult = await pool.query(
      `
        SELECT
          pak.project_id::text AS project_id,
          p.name AS project_name,
          p.status::text AS project_status,
          p.owner_user_id::text AS owner_user_id,
          pak.key_prefix,
          pak.key_last4,
          pak.is_enabled,
          pak.created_by_user_id::text AS created_by_user_id,
          pak.rotated_at,
          pak.last_used_at,
          pak.created_at,
          pak.updated_at
        FROM project_api_keys pak
        JOIN projects p ON p.id = pak.project_id
        WHERE pak.project_id = $1
        LIMIT 1
      `,
      [projectId]
    );
    if (!rowResult.rowCount) {
      return res.status(500).json({ error: 'Failed to load updated project API key row' });
    }
    const projectContext = await getTelegramProjectContext([projectId]);
    const mapped = mapProjectApiAdminRow(rowResult.rows[0]);
    const context = projectContext.contextByProjectId[mapped.projectId];

    return res.json({
      ok: true,
      api: {
        ...mapped,
        sourceType: context?.telegramId ? 'telegram' : 'manual',
        telegramId: context?.telegramId || null,
        telegramBotUsername: context?.telegramBotUsername || null,
      },
    });
  } catch (error) {
    if (error?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid projectId format' });
    }
    console.error('Failed to toggle project API key status:', error);
    return res.status(500).json({ error: 'Failed to toggle project API key status', details: error.message });
  }
});

app.patch('/api/admin/project-apis/runtime-settings', requireSuperAdmin, async (req, res) => {
  const hasGenerateToggle = Object.prototype.hasOwnProperty.call(req.body || {}, 'externalGenerateEnabled');
  const hasAnalyzeToggle = Object.prototype.hasOwnProperty.call(req.body || {}, 'externalAnalyzeEnabled');
  if (!hasGenerateToggle && !hasAnalyzeToggle) {
    return res.status(400).json({
      error: 'At least one setting is required: externalGenerateEnabled or externalAnalyzeEnabled',
    });
  }

  if (hasGenerateToggle && typeof req.body.externalGenerateEnabled !== 'boolean') {
    return res.status(400).json({ error: 'externalGenerateEnabled must be a boolean' });
  }
  if (hasAnalyzeToggle && typeof req.body.externalAnalyzeEnabled !== 'boolean') {
    return res.status(400).json({ error: 'externalAnalyzeEnabled must be a boolean' });
  }

  try {
    await ensureProjectApiPipelineTables({ force: true });
    const current = await getProjectApiRuntimeSettings();
    const nextGenerate = hasGenerateToggle
      ? req.body.externalGenerateEnabled
      : current.externalGenerateEnabled;
    const nextAnalyze = hasAnalyzeToggle
      ? req.body.externalAnalyzeEnabled
      : current.externalAnalyzeEnabled;

    const updatedResult = await pool.query(
      `
        UPDATE project_api_runtime_settings
        SET external_generate_enabled = $2,
            external_analyze_enabled = $3,
            updated_at = NOW()
        WHERE id = $1
        RETURNING external_generate_enabled, external_analyze_enabled, updated_at
      `,
      [PROJECT_API_RUNTIME_SETTINGS_SINGLETON_ID, nextGenerate, nextAnalyze]
    );

    if (!updatedResult.rowCount) {
      return res.status(500).json({ error: 'Failed to update runtime settings' });
    }

    return res.json({
      ok: true,
      runtimeSettings: normalizeProjectApiRuntimeSettingsRow(updatedResult.rows[0]),
    });
  } catch (error) {
    console.error('Failed to update project API runtime settings:', error);
    return res.status(500).json({
      error: 'Failed to update runtime settings',
      details: error.message,
    });
  }
});

app.put('/api/admin/project-apis/:projectId/pipeline-policy', requireSuperAdmin, async (req, res) => {
  const projectId = String(req.params?.projectId || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    await ensureProjectApiPipelineTables({ force: true });
    const projectResult = await pool.query(
      `
        SELECT id
        FROM projects
        WHERE id = $1::uuid
        LIMIT 1
      `,
      [projectId]
    );
    if (!projectResult.rowCount) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const existingPolicy = await ensureProjectApiPipelinePolicyRow(projectId);
    const generatePipelineSet = new Set(PROJECT_API_GENERATE_PIPELINES);
    const analyzePipelineSet = new Set(PROJECT_API_ANALYZE_PIPELINES);

    let allowedGeneratePipelines = cloneStringList(existingPolicy.allowedGeneratePipelines);
    let allowedAnalyzePipelines = cloneStringList(existingPolicy.allowedAnalyzePipelines);
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedGeneratePipelines')) {
      const parsed = parseRequestedPipelineAllowlist(req.body.allowedGeneratePipelines, generatePipelineSet);
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'allowedGeneratePipelines must be an array of valid pipeline names',
          allowed: cloneStringList(PROJECT_API_GENERATE_PIPELINES),
        });
      }
      allowedGeneratePipelines = parsed.value;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'allowedAnalyzePipelines')) {
      const parsed = parseRequestedPipelineAllowlist(req.body.allowedAnalyzePipelines, analyzePipelineSet);
      if (!parsed.ok) {
        return res.status(400).json({
          error: 'allowedAnalyzePipelines must be an array of valid pipeline names',
          allowed: cloneStringList(PROJECT_API_ANALYZE_PIPELINES),
        });
      }
      allowedAnalyzePipelines = parsed.value;
    }

    const requestedDefaultGenerate = normalizePipelineToken(req.body?.defaultGeneratePipeline);
    const requestedDefaultAnalyze = normalizePipelineToken(req.body?.defaultAnalyzePipeline);
    let defaultGeneratePipeline = requestedDefaultGenerate || normalizePipelineToken(existingPolicy.defaultGeneratePipeline);
    let defaultAnalyzePipeline = requestedDefaultAnalyze || normalizePipelineToken(existingPolicy.defaultAnalyzePipeline);
    if (!generatePipelineSet.has(defaultGeneratePipeline)) {
      if (requestedDefaultGenerate) {
        return res.status(400).json({
          error: 'defaultGeneratePipeline must be a valid generate pipeline',
        });
      }
      defaultGeneratePipeline = DEFAULT_PROJECT_API_PIPELINE_POLICY.defaultGeneratePipeline;
    }
    if (!analyzePipelineSet.has(defaultAnalyzePipeline)) {
      if (requestedDefaultAnalyze) {
        return res.status(400).json({
          error: 'defaultAnalyzePipeline must be a valid analyze pipeline',
        });
      }
      defaultAnalyzePipeline = DEFAULT_PROJECT_API_PIPELINE_POLICY.defaultAnalyzePipeline;
    }

    const allowGenerateOverride = Object.prototype.hasOwnProperty.call(req.body || {}, 'allowGenerateOverride')
      ? req.body.allowGenerateOverride
      : existingPolicy.allowGenerateOverride;
    const allowAnalyzeOverride = Object.prototype.hasOwnProperty.call(req.body || {}, 'allowAnalyzeOverride')
      ? req.body.allowAnalyzeOverride
      : existingPolicy.allowAnalyzeOverride;
    if (typeof allowGenerateOverride !== 'boolean') {
      return res.status(400).json({ error: 'allowGenerateOverride must be a boolean' });
    }
    if (typeof allowAnalyzeOverride !== 'boolean') {
      return res.status(400).json({ error: 'allowAnalyzeOverride must be a boolean' });
    }

    const upsertResult = await pool.query(
      `
        INSERT INTO project_api_pipeline_policies (
          project_id,
          default_generate_pipeline,
          allowed_generate_pipelines,
          allow_generate_override,
          default_analyze_pipeline,
          allowed_analyze_pipelines,
          allow_analyze_override,
          updated_at
        )
        VALUES (
          $1::uuid, $2, $3::text[], $4, $5, $6::text[], $7, NOW()
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          default_generate_pipeline = EXCLUDED.default_generate_pipeline,
          allowed_generate_pipelines = EXCLUDED.allowed_generate_pipelines,
          allow_generate_override = EXCLUDED.allow_generate_override,
          default_analyze_pipeline = EXCLUDED.default_analyze_pipeline,
          allowed_analyze_pipelines = EXCLUDED.allowed_analyze_pipelines,
          allow_analyze_override = EXCLUDED.allow_analyze_override,
          updated_at = NOW()
        RETURNING
          project_id,
          default_generate_pipeline,
          allowed_generate_pipelines,
          allow_generate_override,
          default_analyze_pipeline,
          allowed_analyze_pipelines,
          allow_analyze_override,
          created_at,
          updated_at
      `,
      [
        projectId,
        defaultGeneratePipeline,
        allowedGeneratePipelines,
        allowGenerateOverride,
        defaultAnalyzePipeline,
        allowedAnalyzePipelines,
        allowAnalyzeOverride,
      ]
    );

    if (!upsertResult.rowCount) {
      return res.status(500).json({ error: 'Failed to update pipeline policy' });
    }

    return res.json({
      ok: true,
      policy: normalizeProjectApiPipelinePolicyRow(upsertResult.rows[0]),
    });
  } catch (error) {
    if (error?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid projectId format' });
    }
    console.error('Failed to update project API pipeline policy:', error);
    return res.status(500).json({
      error: 'Failed to update project API pipeline policy',
      details: error.message,
    });
  }
});

app.get('/api/admin/project-apis/:projectId/key', requireSuperAdmin, async (req, res) => {
  const projectId = String(req.params?.projectId || '').trim();
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  try {
    await ensureProjectApiKeysTable({ force: true });
    const result = await pool.query(
      `
        SELECT api_key_encrypted
        FROM project_api_keys
        WHERE project_id = $1
        LIMIT 1
      `,
      [projectId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: 'Project API key not found' });
    }

    const decrypted = decryptProjectApiKey(result.rows[0].api_key_encrypted);
    return res.json({
      ok: true,
      projectId,
      apiKey: decrypted,
    });
  } catch (error) {
    if (error?.code === '22P02') {
      return res.status(400).json({ error: 'Invalid projectId format' });
    }
    console.error('Failed to reveal project API key:', error);
    return res.status(500).json({ error: 'Failed to reveal project API key', details: error.message });
  }
});

app.post('/api/admin/users', requireSuperAdmin, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const emailRaw = String(req.body?.email || '').trim();
  const email = emailRaw.toLowerCase();
  const password = String(req.body?.password || '');
  const role = String(req.body?.role || 'member').toLowerCase();
  const planTier = normalizePlanTier(req.body?.planTier);
  const isActive = req.body?.isActive === false ? false : true;

  if (!username || username.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (role !== 'admin' && role !== 'member') {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (String(username).toLowerCase() === String(DEFAULT_SADMIN_USERNAME || 'sadmin').toLowerCase()) {
    return res.status(409).json({ error: 'Reserved username. Please choose another username.' });
  }

  try {
    const plan = getPlanConfig(planTier);
    const hash = await bcrypt.hash(password, 10);
    const created = await pool.query(
      `
        INSERT INTO users (
          username, email, password_hash, role, bot_state, credits,
          plan_tier, plan_status, daily_credit_quota, last_credit_reset, is_active
        )
        VALUES (
          $1, NULLIF($2, ''), $3, $4::user_role, 'IDLE', $5,
          $6, 'active', $5, CURRENT_DATE, $7
        )
        RETURNING id, username, email, role, plan_tier, credits, daily_credit_quota, is_active, last_login_at, created_at
      `,
      [username, email, hash, role, plan.monthlyCredits, plan.tier, isActive]
    );

    const user = created.rows[0];
    return res.status(201).json({
      ok: true,
      user: {
        ...user,
        is_super_admin: false,
        joined_at: user.created_at || user.last_login_at || null,
      },
    });
  } catch (error) {
    if (error?.code === '23505') {
      const detail = String(error?.detail || '').toLowerCase();
      if (detail.includes('username')) return res.status(409).json({ error: 'Username already exists' });
      if (detail.includes('email')) return res.status(409).json({ error: 'Email already exists' });
      if (detail.includes('telegram_id')) return res.status(409).json({ error: 'Telegram already linked to another user' });
      return res.status(409).json({ error: 'User already exists' });
    }
    console.error('Admin create user failed:', error.message);
    return res.status(500).json({ error: 'Failed to create user', details: error.message });
  }
});

app.put('/api/admin/users/:id', requireSuperAdmin, async (req, res) => {
  const userId = String(req.params?.id || '').trim();
  if (!userId) {
    return res.status(400).json({ error: 'User id is required' });
  }

  const username = String(req.body?.username || '').trim();
  const emailRaw = String(req.body?.email || '').trim();
  const email = emailRaw.toLowerCase();
  const password = String(req.body?.password || '').trim();
  const role = String(req.body?.role || 'member').toLowerCase();
  const planTier = normalizePlanTier(req.body?.planTier);
  const isActive = req.body?.isActive === false ? false : true;
  const parsedCredits = Number(req.body?.credits);
  const hasCreditsInput = String(req.body?.credits ?? '').trim() !== '';

  if (!username || username.length < 2) {
    return res.status(400).json({ error: 'Username must be at least 2 characters' });
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }
  if (password && password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (role !== 'admin' && role !== 'member') {
    return res.status(400).json({ error: 'Invalid role' });
  }
  if (hasCreditsInput && (!Number.isFinite(parsedCredits) || parsedCredits < 0)) {
    return res.status(400).json({ error: 'Credits must be a non-negative number' });
  }

  try {
    const existingResult = await pool.query(
      `
        SELECT id, username, role, plan_tier, credits
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );
    if (!existingResult.rowCount) {
      return res.status(404).json({ error: 'User not found' });
    }

    const existingUser = existingResult.rows[0];
    const targetIsSuperAdmin = isSuperAdminUser(existingUser);
    if (targetIsSuperAdmin && !isActive) {
      return res.status(400).json({ error: 'Cannot deactivate super admin user' });
    }

    const nextRole = targetIsSuperAdmin ? 'admin' : role;
    const nextUsername = targetIsSuperAdmin ? DEFAULT_SADMIN_USERNAME : username;
    const nextPlanTier = targetIsSuperAdmin ? 'pro' : planTier;
    const nextPlan = getPlanConfig(nextPlanTier);
    const planChanged = normalizePlanTier(existingUser.plan_tier) !== nextPlanTier;
    const nextCredits = hasCreditsInput
      ? Math.floor(parsedCredits)
      : planChanged
        ? nextPlan.monthlyCredits
        : Number(existingUser.credits || 0);

    const updated = await pool.query(
      `
        UPDATE users
        SET username = $1,
            email = NULLIF($2, ''),
            role = $3::user_role,
            plan_tier = $4,
            plan_status = 'active',
            daily_credit_quota = $5,
            credits = $6,
            is_active = $7,
            updated_at = NOW()
        WHERE id = $8
        RETURNING id, username, email, role, plan_tier, credits, daily_credit_quota, is_active, last_login_at, created_at
      `,
      [nextUsername, email, nextRole, nextPlan.tier, nextPlan.monthlyCredits, nextCredits, targetIsSuperAdmin ? true : isActive, userId]
    );

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        `
          UPDATE users
          SET password_hash = $1,
              updated_at = NOW()
          WHERE id = $2
        `,
        [hash, userId]
      );
    }

    const user = updated.rows[0];
    return res.json({
      ok: true,
      user: {
        ...user,
        is_super_admin: isSuperAdminUser(user),
        joined_at: user.created_at || user.last_login_at || null,
      },
    });
  } catch (error) {
    if (error?.code === '23505') {
      const detail = String(error?.detail || '').toLowerCase();
      if (detail.includes('username')) return res.status(409).json({ error: 'Username already exists' });
      if (detail.includes('email')) return res.status(409).json({ error: 'Email already exists' });
      return res.status(409).json({ error: 'Duplicate value conflict' });
    }
    console.error('Admin update user failed:', error.message);
    return res.status(500).json({ error: 'Failed to update user', details: error.message });
  }
});

app.delete('/api/admin/users/:id', requireSuperAdmin, async (req, res) => {
  const userId = String(req.params?.id || '').trim();
  if (!userId) {
    return res.status(400).json({ error: 'User id is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existingResult = await client.query(
      `
        SELECT id, username, role
        FROM users
        WHERE id = $1
        LIMIT 1
        FOR UPDATE
      `,
      [userId]
    );
    if (!existingResult.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User not found' });
    }

    const target = existingResult.rows[0];
    if (isSuperAdminUser(target)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot delete super admin user' });
    }

    await client.query(
      `
        DELETE FROM users
        WHERE id = $1
      `,
      [userId]
    );
    await client.query('COMMIT');

    return res.json({ ok: true, deleted: true });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Admin delete user failed:', error.message);
    return res.status(500).json({ error: 'Failed to delete user', details: error.message });
  } finally {
    client.release();
  }
});

app.put('/api/auth/profile', requireAuth, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const emailRaw = String(req.body?.email || '').trim();
  const phoneRaw = String(req.body?.phone || '').trim();
  const email = emailRaw.toLowerCase();
  const phone = phoneRaw.slice(0, 40);

  if (!username || username.length < 2) {
    return res.status(400).json({ error: 'Full name must be at least 2 characters' });
  }
  if (email && !EMAIL_REGEX.test(email)) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  try {
    const updatedResult = await pool.query(
      `
        UPDATE users
        SET username = $1,
            email = NULLIF($2, ''),
            bot_data = jsonb_set(COALESCE(bot_data, '{}'::jsonb), '{phone}', to_jsonb($3::text), true)
        WHERE id = $4
        RETURNING *
      `,
      [username, email, phone, req.user.id]
    );

    return res.json({
      ok: true,
      user: buildAuthUserPayload(updatedResult.rows[0]),
    });
  } catch (error) {
    if (error?.code === '23505') {
      return res.status(409).json({ error: 'Username or email is already in use' });
    }
    console.error('Profile update failed:', error.message);
    return res.status(500).json({ error: 'Profile update failed', details: error.message });
  }
});

app.post('/api/auth/change-password', requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword || '');
  const newPassword = String(req.body?.newPassword || '');

  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  try {
    const currentHash = req.user.password_hash;
    if (currentHash) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password is required' });
      }
      const valid = await bcrypt.compare(currentPassword, currentHash);
      if (!valid) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }

    const nextHash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      `
        UPDATE users
        SET password_hash = $1
        WHERE id = $2
      `,
      [nextHash, req.user.id]
    );

    return res.json({ ok: true, message: 'Password updated successfully' });
  } catch (error) {
    console.error('Change password failed:', error.message);
    return res.status(500).json({ error: 'Change password failed', details: error.message });
  }
});

const ANALYZE_REFERENCE_PROMPT =
  "You are an expert ad-creative analyzer. " +
  "Carefully inspect the product image and infer the strongest marketing direction. " +
  "Think through product identity, mood, palette, composition, and ad intent internally, then return STRICT JSON only. " +
  "Return exactly these keys: " +
  "productName, mainIngredient, visualMood, dynamicElements, colorPalette, backgroundStyle, " +
  "brandName, ctaText, aspectRatio, cameraAngle, lightingFocus, extraNotes. " +
  "Do your best to infer useful values from the image; avoid empty fields whenever possible. " +
  "Rules: " +
  "aspectRatio must be one of: 1:1, 9:16, 4:5, 16:9. " +
  "cameraAngle must be one of: eye-level, top-down, low-angle, three-quarter. " +
  "lightingFocus must be one of: softbox, cinematic, studio, natural. " +
  "ctaText must be one of: Shop Now, Buy Now, Learn More, Get Offer, Order Today. " +
  "backgroundStyle must describe a dynamic ad-ready environment; avoid plain white isolate/cutout wording unless explicitly required by the visible scene. " +
  "Keep values concise, specific, and ad-usable. No markdown.";

const ANALYZE_COMPLETION_PROMPT =
  "You are an expert ad prompt strategist. " +
  "Given the first-pass extracted JSON from a product image, improve and complete it for high-converting ad generation. " +
  "Return STRICT JSON only with these exact keys: " +
  "productName, mainIngredient, visualMood, dynamicElements, colorPalette, backgroundStyle, brandName, ctaText, aspectRatio, cameraAngle, lightingFocus, extraNotes. " +
  "Fill every key with non-empty, practical, and specific values. " +
  "Rules: ctaText must be one of Shop Now, Buy Now, Learn More, Get Offer, Order Today. " +
  "aspectRatio must be one of 1:1, 9:16, 4:5, 16:9. " +
  "cameraAngle must be one of eye-level, top-down, low-angle, three-quarter. " +
  "lightingFocus must be one of softbox, cinematic, studio, natural. " +
  "backgroundStyle must be dynamic and ad-ready, never plain white isolate wording. " +
  "Keep values compact and production-usable.";

const ANALYZE_CREATIVE_PLAN_PROMPT =
  "You are a senior product-ad creative strategist. " +
  "Study the uploaded product image and build the best single concept to present this exact product in a premium, conversion-ready ad. " +
  "Return STRICT JSON only (no markdown) with exact keys: " +
  "productIdentity, heroFocusStrategy, compositionBlueprint, lightingPaletteDirection, backgroundDirection, allowedAccents, constraints, recommendedAspectRatio, notes. " +
  "Schema rules: " +
  "productIdentity must include productName and mainIngredient. " +
  "compositionBlueprint must include cameraAngle, productScaleGuidance, framingNotes, supportSurface. " +
  "lightingPaletteDirection must include lightingFocus, visualMood, colorPalette. " +
  "allowedAccents must include dynamicElements, maxAccentCount, doNotCoverLabel. " +
  "constraints must include booleans: singleProductOnly, noDuplicateContainer, noRandomTextOrWatermark, preserveCoreProductIdentity, overlayTextDefaultOff. " +
  "recommendedAspectRatio must be one of: 1:1, 9:16, 4:5, 16:9. " +
  "cameraAngle must be one of: eye-level, top-down, low-angle, three-quarter. " +
  "lightingFocus must be one of: softbox, cinematic, studio, natural. " +
  "Hard constraints must be true. Avoid random typography and avoid duplicate product forms.";

const ANALYZE_CREATIVE_PLAN_RETRY_PROMPT =
  "The previous concept failed quality gate checks. " +
  "Revise the plan to fix all failed checks while preserving strong product focus and realism. " +
  "Do not add extra product objects. Keep output JSON-only.";

const ANALYZE_QUALITY_GATE_PROMPT =
  "You are a strict quality gate for product-ad creative plans. " +
  "Evaluate whether the provided plan will generate a high-quality result that keeps the uploaded product as the clear hero. " +
  "Return STRICT JSON only with exact keys: qualityScore, criticalChecks, failureReasons, summary. " +
  "qualityScore must be 0-100. " +
  "criticalChecks must include booleans: singleProductFocus, noDuplicateProductForms, preservesProductIdentity, noRandomTextWatermark, compositionCommercialReady. " +
  "failureReasons must be an array of short actionable strings. " +
  "Be strict and fail when constraints are weak, vague, or likely to produce random clutter.";

const ANALYZE_QUALITY_SCORE_THRESHOLD = (() => {
  const parsed = Number(process.env.ANALYZE_QUALITY_SCORE_THRESHOLD || '78');
  if (!Number.isFinite(parsed)) {
    return 78;
  }
  return Math.max(50, Math.min(100, Math.round(parsed)));
})();
const ANALYZE_QUALITY_RETRY_LIMIT = 1;

const normalizeAnalyzeAspectRatio = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('9:16')) return '9:16';
  if (raw.includes('4:5')) return '4:5';
  if (raw.includes('16:9')) return '16:9';
  if (raw.includes('1:1') || raw.includes('square')) return '1:1';
  if (raw.includes('story') || raw.includes('reel') || raw.includes('vertical')) return '9:16';
  if (raw.includes('portrait')) return '4:5';
  if (raw.includes('landscape') || raw.includes('wide')) return '16:9';
  return '';
};

const normalizeAnalyzeLightingFocus = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('softbox') || raw.includes('soft light') || raw.includes('diffused')) return 'softbox';
  if (raw.includes('cinematic') || raw.includes('dramatic') || raw.includes('moody')) return 'cinematic';
  if (raw.includes('studio') || raw.includes('clean')) return 'studio';
  if (raw.includes('natural') || raw.includes('sunlight') || raw.includes('daylight')) return 'natural';
  return '';
};

const normalizeAnalyzeCta = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw || raw === 'none') return '';
  if (raw.includes('shop')) return 'Shop Now';
  if (raw.includes('buy')) return 'Buy Now';
  if (raw.includes('learn')) return 'Learn More';
  if (raw.includes('offer') || raw.includes('deal')) return 'Get Offer';
  if (raw.includes('order')) return 'Order Today';
  return '';
};

const normalizeAnalyzeCameraAngle = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('top')) return 'top-down';
  if (raw.includes('low')) return 'low-angle';
  if (raw.includes('three') || raw.includes('quarter') || raw.includes('3/4')) return 'three-quarter';
  if (raw.includes('eye')) return 'eye-level';
  return '';
};

const buildDynamicAnalyzeBackgroundStyle = (parsed = {}) => {
  const visualMood = String(parsed?.visualMood || '').trim();
  const colorPalette = String(parsed?.colorPalette || '').trim();
  const mainIngredient = String(parsed?.mainIngredient || '').trim();
  const dynamicElements = String(parsed?.dynamicElements || '').trim();

  const moodPart = visualMood ? `${visualMood} ` : 'premium ';
  const anchorPart = colorPalette || mainIngredient || 'brand-toned gradient';
  const motionPart = dynamicElements
    ? ` with ${dynamicElements.toLowerCase()} accents`
    : ' with subtle motion accents';

  return `${moodPart}${anchorPart} backdrop${motionPart}, soft depth, and clean reflections`;
};

const normalizeAnalyzeBackgroundStyle = (parsed = {}) => {
  const raw = String(parsed?.backgroundStyle || '').trim();
  if (!raw) {
    return buildDynamicAnalyzeBackgroundStyle(parsed);
  }

  const lowered = raw.toLowerCase();
  const flatWhiteHints = [
    'solid white',
    'white isolate',
    'white background',
    'plain white',
    'studio white',
    'isolated',
    'isolate',
    'transparent background',
    'cutout',
    'blank background',
  ];
  const looksFlatWhite = flatWhiteHints.some((hint) => lowered.includes(hint));
  if (looksFlatWhite) {
    return buildDynamicAnalyzeBackgroundStyle(parsed);
  }
  return raw;
};

const normalizeAnalyzeResponse = (parsed) => ({
  productName: parsed?.productName || '',
  mainIngredient: parsed?.mainIngredient || '',
  visualMood: parsed?.visualMood || '',
  dynamicElements: parsed?.dynamicElements || '',
  colorPalette: parsed?.colorPalette || '',
  backgroundStyle: normalizeAnalyzeBackgroundStyle(parsed),
  brandName: parsed?.brandName || '',
  ctaText: normalizeAnalyzeCta(parsed?.ctaText),
  aspectRatio: normalizeAnalyzeAspectRatio(parsed?.aspectRatio),
  cameraAngle: normalizeAnalyzeCameraAngle(parsed?.cameraAngle),
  lightingFocus: normalizeAnalyzeLightingFocus(parsed?.lightingFocus),
  extraNotes: parsed?.extraNotes || '',
});

const completeAnalyzeResponse = (parsed = {}) => {
  const normalized = normalizeAnalyzeResponse(parsed);
  const productName = String(normalized.productName || normalized.brandName || '').trim() || 'Premium product hero';
  const brandName = String(normalized.brandName || productName).trim();
  const mainIngredient = String(normalized.mainIngredient || '').trim() || 'signature ingredient accents';
  const visualMood = String(normalized.visualMood || '').trim() || 'premium cinematic';
  const dynamicElements = String(normalized.dynamicElements || '').trim() || 'liquid splash, floating accents, glow particles';
  const colorPalette = String(normalized.colorPalette || '').trim() || 'rich product-matched tones with deep contrast';

  const composed = {
    ...normalized,
    productName,
    mainIngredient,
    visualMood,
    dynamicElements,
    colorPalette,
    backgroundStyle: normalizeAnalyzeBackgroundStyle({
      ...normalized,
      productName,
      mainIngredient,
      visualMood,
      dynamicElements,
      colorPalette,
    }),
    brandName,
    ctaText: normalized.ctaText || 'Shop Now',
    aspectRatio: normalized.aspectRatio || '1:1',
    cameraAngle: normalized.cameraAngle || 'eye-level',
    lightingFocus: normalized.lightingFocus || 'softbox',
  };

  const extraNotes = String(normalized.extraNotes || '').trim() || [
    `Use a ${composed.cameraAngle} hero framing.`,
    `Keep product edges crisp with ${composed.lightingFocus} lighting.`,
    `Scene should feel ${composed.visualMood} with ${composed.dynamicElements}.`,
    `Maintain ${composed.colorPalette} harmony and clear conversion-focused composition.`,
  ].join(' ');

  return {
    ...composed,
    extraNotes,
  };
};

const pickFirstNonEmptyString = (...values) => {
  for (const value of values) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized) {
      return normalized;
    }
  }
  return '';
};

const normalizeAnalyzeBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['true', 'yes', '1', 'on', 'pass'].includes(normalized)) {
    return true;
  }
  if (['false', 'no', '0', 'off', 'fail'].includes(normalized)) {
    return false;
  }
  return fallback;
};

const normalizeAnalyzeFailureReasons = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, 6);
  }
  const text = String(value || '').trim();
  if (!text) {
    return [];
  }
  return text
    .split(/[\n;|]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 6);
};

const normalizeCreativePlanConstraints = (constraints = {}) => ({
  singleProductOnly: normalizeAnalyzeBoolean(constraints?.singleProductOnly, true),
  noDuplicateContainer: normalizeAnalyzeBoolean(constraints?.noDuplicateContainer, true),
  noRandomTextOrWatermark: normalizeAnalyzeBoolean(constraints?.noRandomTextOrWatermark, true),
  preserveCoreProductIdentity: normalizeAnalyzeBoolean(constraints?.preserveCoreProductIdentity, true),
  overlayTextDefaultOff: normalizeAnalyzeBoolean(constraints?.overlayTextDefaultOff, true),
});

const normalizeCreativePlan = (plan = {}) => {
  const productIdentity = plan?.productIdentity && typeof plan.productIdentity === 'object'
    ? plan.productIdentity
    : {};
  const compositionBlueprint = plan?.compositionBlueprint && typeof plan.compositionBlueprint === 'object'
    ? plan.compositionBlueprint
    : {};
  const lightingPaletteDirection = plan?.lightingPaletteDirection && typeof plan.lightingPaletteDirection === 'object'
    ? plan.lightingPaletteDirection
    : {};
  const allowedAccents = plan?.allowedAccents && typeof plan.allowedAccents === 'object'
    ? plan.allowedAccents
    : {};

  const maxAccentCountRaw = Number(
    allowedAccents?.maxAccentCount ||
    allowedAccents?.maxCount ||
    plan?.maxAccentCount ||
    3
  );
  const maxAccentCount = Number.isFinite(maxAccentCountRaw)
    ? Math.min(4, Math.max(1, Math.round(maxAccentCountRaw)))
    : 3;

  return {
    productIdentity: {
      productName: pickFirstNonEmptyString(
        productIdentity?.productName,
        plan?.productName
      ),
      mainIngredient: pickFirstNonEmptyString(
        productIdentity?.mainIngredient,
        plan?.mainIngredient
      ),
    },
    heroFocusStrategy: pickFirstNonEmptyString(
      plan?.heroFocusStrategy,
      plan?.heroStrategy
    ),
    compositionBlueprint: {
      cameraAngle: pickFirstNonEmptyString(
        compositionBlueprint?.cameraAngle,
        plan?.cameraAngle
      ),
      productScaleGuidance: pickFirstNonEmptyString(
        compositionBlueprint?.productScaleGuidance,
        compositionBlueprint?.productScale,
        plan?.productScaleGuidance
      ),
      framingNotes: pickFirstNonEmptyString(
        compositionBlueprint?.framingNotes,
        compositionBlueprint?.framing,
        plan?.framingNotes
      ),
      supportSurface: pickFirstNonEmptyString(
        compositionBlueprint?.supportSurface,
        plan?.supportSurface
      ),
    },
    lightingPaletteDirection: {
      lightingFocus: pickFirstNonEmptyString(
        lightingPaletteDirection?.lightingFocus,
        plan?.lightingFocus
      ),
      visualMood: pickFirstNonEmptyString(
        lightingPaletteDirection?.visualMood,
        plan?.visualMood
      ),
      colorPalette: pickFirstNonEmptyString(
        lightingPaletteDirection?.colorPalette,
        plan?.colorPalette
      ),
    },
    backgroundDirection: pickFirstNonEmptyString(
      plan?.backgroundDirection,
      plan?.backgroundStyle
    ),
    allowedAccents: {
      dynamicElements: pickFirstNonEmptyString(
        allowedAccents?.dynamicElements,
        allowedAccents?.elements,
        plan?.dynamicElements
      ),
      maxAccentCount,
      doNotCoverLabel: normalizeAnalyzeBoolean(
        allowedAccents?.doNotCoverLabel,
        true
      ),
    },
    constraints: {
      ...normalizeCreativePlanConstraints(plan?.constraints || {}),
      singleProductOnly: true,
      noDuplicateContainer: true,
      noRandomTextOrWatermark: true,
      preserveCoreProductIdentity: true,
      overlayTextDefaultOff: true,
    },
    recommendedAspectRatio: pickFirstNonEmptyString(
      plan?.recommendedAspectRatio,
      plan?.aspectRatio
    ),
    notes: pickFirstNonEmptyString(plan?.notes, plan?.extraNotes),
  };
};

const buildBoundAnalyzeDynamicElements = (value, maxAccentCount = 3) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'subtle ingredient accents, micro droplets, gentle motion cues';
  }
  const split = normalized
    .split(/[,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (split.length <= 1) {
    return normalized;
  }
  return split.slice(0, Math.max(1, maxAccentCount)).join(', ');
};

const mapCreativePlanToAnalyzeFields = (creativePlan = {}) => {
  const normalizedPlan = normalizeCreativePlan(creativePlan);
  const cameraAngle = normalizeAnalyzeCameraAngle(normalizedPlan?.compositionBlueprint?.cameraAngle) || 'eye-level';
  const lightingFocus = normalizeAnalyzeLightingFocus(normalizedPlan?.lightingPaletteDirection?.lightingFocus) || 'softbox';
  const aspectRatio = normalizeAnalyzeAspectRatio(normalizedPlan?.recommendedAspectRatio) || '1:1';
  const productName = pickFirstNonEmptyString(
    normalizedPlan?.productIdentity?.productName,
    'Premium product hero'
  );
  const mainIngredient = pickFirstNonEmptyString(
    normalizedPlan?.productIdentity?.mainIngredient,
    'signature ingredient accents'
  );
  const visualMood = pickFirstNonEmptyString(
    normalizedPlan?.lightingPaletteDirection?.visualMood,
    'premium cinematic'
  );
  const colorPalette = pickFirstNonEmptyString(
    normalizedPlan?.lightingPaletteDirection?.colorPalette,
    'rich product-matched tones with controlled contrast'
  );
  const dynamicElements = buildBoundAnalyzeDynamicElements(
    normalizedPlan?.allowedAccents?.dynamicElements,
    normalizedPlan?.allowedAccents?.maxAccentCount || 3
  );
  const backgroundStyle = normalizeAnalyzeBackgroundStyle({
    visualMood,
    colorPalette,
    mainIngredient,
    dynamicElements,
    backgroundStyle: normalizedPlan?.backgroundDirection,
  });

  const extraNotes = [
    pickFirstNonEmptyString(
      normalizedPlan?.heroFocusStrategy,
      'Keep the product as the clear hero subject with premium, photoreal realism.'
    ),
    `Composition blueprint: ${pickFirstNonEmptyString(normalizedPlan?.compositionBlueprint?.framingNotes, 'clean hero framing with strong product readability')}.`,
    `Camera angle: ${cameraAngle}. Support surface: ${pickFirstNonEmptyString(normalizedPlan?.compositionBlueprint?.supportSurface, 'natural grounded surface')}.`,
    `Product scale guidance: ${pickFirstNonEmptyString(normalizedPlan?.compositionBlueprint?.productScaleGuidance, 'product occupies around 45-55% of frame height')}.`,
    'Hard constraints: single hero product only; no duplicate container or second product form; no random text or watermark; preserve uploaded product identity exactly.',
    'If no explicit overlay is requested, keep brand text and CTA overlays off by default. Keep accents subtle, supporting, and away from label coverage.',
    pickFirstNonEmptyString(normalizedPlan?.notes, ''),
  ]
    .filter(Boolean)
    .join(' ');

  return {
    productName,
    mainIngredient,
    visualMood,
    dynamicElements,
    colorPalette,
    backgroundStyle,
    brandName: '',
    ctaText: '',
    aspectRatio,
    cameraAngle,
    lightingFocus,
    extraNotes,
  };
};

const normalizeCreativePlanQualityGate = (parsed = {}) => {
  const qualityScoreRaw = Number(
    parsed?.qualityScore ??
    parsed?.score ??
    parsed?.overallScore ??
    0
  );
  const qualityScore = Number.isFinite(qualityScoreRaw)
    ? Math.max(0, Math.min(100, Math.round(qualityScoreRaw)))
    : 0;

  const criticalChecksSource = parsed?.criticalChecks && typeof parsed.criticalChecks === 'object'
    ? parsed.criticalChecks
    : (parsed?.checks && typeof parsed.checks === 'object' ? parsed.checks : {});

  const criticalChecks = {
    singleProductFocus: normalizeAnalyzeBoolean(
      criticalChecksSource?.singleProductFocus ?? criticalChecksSource?.singleHeroProduct ?? criticalChecksSource?.singleProductOnly,
      false
    ),
    noDuplicateProductForms: normalizeAnalyzeBoolean(
      criticalChecksSource?.noDuplicateProductForms ?? criticalChecksSource?.noDuplicateContainer,
      false
    ),
    preservesProductIdentity: normalizeAnalyzeBoolean(
      criticalChecksSource?.preservesProductIdentity ?? criticalChecksSource?.preserveCoreProductIdentity,
      false
    ),
    noRandomTextWatermark: normalizeAnalyzeBoolean(
      criticalChecksSource?.noRandomTextWatermark ?? criticalChecksSource?.noRandomTextOrWatermark,
      false
    ),
    compositionCommercialReady: normalizeAnalyzeBoolean(
      criticalChecksSource?.compositionCommercialReady ?? criticalChecksSource?.commercialReady,
      false
    ),
  };

  const failedCheckReasons = Object.entries(criticalChecks)
    .filter(([, value]) => value !== true)
    .map(([key]) => {
      if (key === 'singleProductFocus') return 'Hero-product focus is weak or unclear.';
      if (key === 'noDuplicateProductForms') return 'Plan may allow duplicate/stacked product forms.';
      if (key === 'preservesProductIdentity') return 'Core product identity protection is not strict enough.';
      if (key === 'noRandomTextWatermark') return 'Text/watermark suppression is not explicit enough.';
      if (key === 'compositionCommercialReady') return 'Composition is not reliably ad-ready/commercial.';
      return 'Critical quality check failed.';
    });

  const failureReasons = normalizeAnalyzeFailureReasons(
    parsed?.failureReasons || parsed?.issues || parsed?.warnings
  );
  const mergedFailureReasons = [...failureReasons, ...failedCheckReasons]
    .filter(Boolean)
    .slice(0, 6);

  const criticalChecksPassed = Object.values(criticalChecks).every(Boolean);
  const gatePassed = qualityScore >= ANALYZE_QUALITY_SCORE_THRESHOLD && criticalChecksPassed;

  return {
    qualityScore,
    gatePassed,
    criticalChecks,
    failureReasons: gatePassed ? [] : mergedFailureReasons,
    summary: pickFirstNonEmptyString(parsed?.summary, parsed?.rationale),
  };
};

const normalizeGeminiModelName = (value) => {
  const raw = String(value || '').trim().replace(/^models\//i, '');
  if (!raw) return '';
  if (raw === 'gemini-1.5-flash-latest') {
    return 'gemini-2.5-flash';
  }
  return raw;
};

const buildGeminiModelFallbackList = (models = []) => (
  Array.from(
    new Set(
      (Array.isArray(models) ? models : [models])
        .map((item) => normalizeGeminiModelName(item))
        .filter(Boolean)
    )
  )
);

const getAnalyzeGeminiModels = () => buildGeminiModelFallbackList([
  String(process.env.GEMINI_ANALYZE_MODEL || 'gemini-2.5-pro').trim(),
  String(process.env.GEMINI_VISION_MODEL || '').trim(),
  String(process.env.GEMINI_TEXT_MODEL || '').trim(),
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  String(process.env.GEMINI_MODEL || '').trim(),
]);

const generateCreativePlanWithGemini = async ({
  imagePayload,
  apiKey,
  retryFeedback = '',
  previousPlan = null,
}) => {
  const models = getAnalyzeGeminiModels();
  const parts = [
    { text: ANALYZE_CREATIVE_PLAN_PROMPT },
  ];

  if (retryFeedback) {
    parts.push({ text: ANALYZE_CREATIVE_PLAN_RETRY_PROMPT });
    if (previousPlan) {
      parts.push({
        text: `Previous creativePlan JSON (revise this):\n${JSON.stringify(previousPlan, null, 2)}`,
      });
    }
    parts.push({
      text: `Failed quality reasons to fix:\n${retryFeedback}`,
    });
  }

  parts.push(
    { text: 'Analyze this uploaded product image and return creativePlan JSON only:' },
    {
      inline_data: {
        data: imagePayload.buffer.toString('base64'),
        mime_type: imagePayload.mimeType,
      },
    }
  );

  const { response, model } = await postGeminiWithModelFallback({
    models,
    apiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.22,
      },
    },
    purpose: 'Creative plan analysis',
  });

  const raw = extractGeminiText(response.data).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to parse Gemini creative plan response');
  }

  return {
    model,
    creativePlan: normalizeCreativePlan(parsed),
  };
};

const evaluateCreativePlanQualityWithGemini = async ({
  imagePayload,
  creativePlan,
  apiKey,
}) => {
  const models = getAnalyzeGeminiModels();
  const { response, model } = await postGeminiWithModelFallback({
    models,
    apiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            { text: ANALYZE_QUALITY_GATE_PROMPT },
            { text: `Proposed creativePlan JSON:\n${JSON.stringify(creativePlan, null, 2)}` },
            { text: 'Source product image for identity/focus checks:' },
            {
              inline_data: {
                data: imagePayload.buffer.toString('base64'),
                mime_type: imagePayload.mimeType,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.08,
      },
    },
    purpose: 'Creative plan quality gate',
  });

  const raw = extractGeminiText(response.data).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to parse Gemini quality gate response');
  }

  return {
    model,
    quality: normalizeCreativePlanQualityGate(parsed),
  };
};

const enrichAnalyzeResponseWithGemini = async ({ baseAnalysis, apiKey }) => {
  const models = buildGeminiModelFallbackList([
    String(process.env.GEMINI_ANALYZE_MODEL || 'gemini-2.5-pro').trim(),
    String(process.env.GEMINI_TEXT_MODEL || '').trim(),
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    String(process.env.GEMINI_MODEL || '').trim(),
  ]);

  const { response, model } = await postGeminiWithModelFallback({
    models,
    apiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            { text: ANALYZE_COMPLETION_PROMPT },
            {
              text:
                `First-pass analysis JSON:\n${JSON.stringify(baseAnalysis || {}, null, 2)}\n` +
                'Improve it and return final completed JSON only.',
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.35,
      },
    },
    purpose: 'Image analysis completion',
  });

  logInfo('Gemini', 'Completed analyze fields', `model=${model}`);
  const raw = extractGeminiText(response.data).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse Gemini analysis completion response');
  }
  return parsed;
};

const analyzeReferenceImageWithAi = async (referenceImage) => {
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
  const completion = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: ANALYZE_REFERENCE_PROMPT,
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this reference image.' },
          { type: 'image_url', image_url: { url: referenceImage } },
        ],
      },
    ],
  });

  const raw = getMessageText(completion.choices?.[0]?.message).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse OpenAI response');
  }
  return normalizeAnalyzeResponse(parsed);
};

const analyzeReferenceImageWithGemini = async (referenceImage) => {
  const imagePayload = parseDataUrl(referenceImage);
  if (!imagePayload?.buffer) {
    throw new Error('Invalid image format for Gemini analysis');
  }

  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini analysis');
  }

  const attempts = [];
  let retryFeedback = '';
  let previousPlan = null;
  let retryCount = 0;

  for (let attemptIndex = 0; attemptIndex <= ANALYZE_QUALITY_RETRY_LIMIT; attemptIndex += 1) {
    const generatedPlan = await generateCreativePlanWithGemini({
      imagePayload,
      apiKey: geminiApiKey,
      retryFeedback,
      previousPlan,
    });
    const evaluatedPlan = await evaluateCreativePlanQualityWithGemini({
      imagePayload,
      creativePlan: generatedPlan.creativePlan,
      apiKey: geminiApiKey,
    });

    attempts.push({
      creativePlan: generatedPlan.creativePlan,
      quality: evaluatedPlan.quality,
      planModel: generatedPlan.model,
      qualityModel: evaluatedPlan.model,
    });

    if (evaluatedPlan.quality.gatePassed) {
      break;
    }

    if (attemptIndex < ANALYZE_QUALITY_RETRY_LIMIT) {
      retryCount += 1;
      previousPlan = generatedPlan.creativePlan;
      retryFeedback = evaluatedPlan.quality.failureReasons.join('; ') ||
        evaluatedPlan.quality.summary ||
        'Quality gate failed';
      logWarn(
        'Gemini',
        'Creative plan quality gate failed, retrying once',
        `score=${evaluatedPlan.quality.qualityScore}; reasons=${retryFeedback}`
      );
    }
  }

  const preferredAttempt =
    attempts.find((attempt) => attempt?.quality?.gatePassed) ||
    attempts
      .slice()
      .sort((a, b) => Number(b?.quality?.qualityScore || 0) - Number(a?.quality?.qualityScore || 0))[0];

  if (!preferredAttempt) {
    throw new Error('Gemini analyze produced no creative plan attempts');
  }

  const mappedFields = mapCreativePlanToAnalyzeFields(preferredAttempt.creativePlan);
  const responsePayload = {
    ...mappedFields,
    creativePlan: preferredAttempt.creativePlan,
    analysisMeta: {
      provider: 'gemini',
      pipelineName: PIPELINE_NAME_GEMINI_CREATIVE_PLAN,
      model: `${preferredAttempt.planModel} | judge:${preferredAttempt.qualityModel}`,
      qualityScore: preferredAttempt.quality.qualityScore,
      gatePassed: preferredAttempt.quality.gatePassed,
      retryCount,
      failureReasons: preferredAttempt.quality.failureReasons,
    },
  };

  logInfo(
    'Gemini',
    'Analyzed product image with creative plan pipeline',
    `model=${responsePayload.analysisMeta.model}; score=${responsePayload.analysisMeta.qualityScore}; gatePassed=${responsePayload.analysisMeta.gatePassed}; retries=${retryCount}`
  );

  return responsePayload;
};

const analyzeReferenceImageWithGeminiQuick = async (referenceImage) => {
  const imagePayload = parseDataUrl(referenceImage);
  if (!imagePayload?.buffer) {
    throw new Error('Invalid image format for Gemini analysis');
  }

  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini analysis');
  }

  const generatedPlan = await generateCreativePlanWithGemini({
    imagePayload,
    apiKey: geminiApiKey,
  });

  const mappedFields = mapCreativePlanToAnalyzeFields(generatedPlan.creativePlan);
  return {
    ...mappedFields,
    creativePlan: generatedPlan.creativePlan,
    analysisMeta: {
      provider: 'gemini',
      pipelineName: PIPELINE_NAME_GEMINI_CREATIVE_PLAN,
      model: generatedPlan.model,
      qualityScore: null,
      gatePassed: null,
      retryCount: 0,
      failureReasons: [],
      fastMode: true,
    },
  };
};

const normalizeReferencePlacement = (parsed = {}) => {
  const clamp01 = (value, fallback) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(1, Math.max(0, numeric));
  };
  const clampRange = (value, min, max, fallback) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
  };
  const centerX = clamp01(parsed.centerX, 0.5);
  const centerY = clamp01(parsed.centerY, 0.5);
  const rotationDeg = clampRange(parsed.rotationDeg, -45, 45, 0);
  const normalizedAnchorPoint = String(parsed.anchorPoint || parsed.contactAnchor || '').trim().toLowerCase();
  const allowedAnchorPoints = new Set([
    'center',
    'bottom-center',
    'top-center',
    'mid-right',
    'mid-left',
    'bottom-right',
    'bottom-left',
  ]);
  const defaultAnchorPoint = Math.abs(rotationDeg) >= 18 ? 'center' : 'bottom-center';

  return {
    centerX,
    centerY,
    widthRatio: clampRange(parsed.widthRatio, 0.12, 0.72, 0.34),
    heightRatio: clampRange(parsed.heightRatio, 0.12, 0.82, 0.48),
    rotationDeg,
    anchorX: clamp01(parsed.anchorX, centerX),
    anchorY: clamp01(parsed.anchorY, centerY),
    anchorPoint: allowedAnchorPoints.has(normalizedAnchorPoint)
      ? normalizedAnchorPoint
      : defaultAnchorPoint,
    placementScale: clampRange(parsed.placementScale, 0.82, 1.35, 1),
    supportSurface: String(parsed.supportSurface || '').trim(),
    contactEdge: String(parsed.contactEdge || '').trim(),
    shadowDirectionDeg: clampRange(
      parsed.shadowDirectionDeg ?? parsed.shadowAngleDeg,
      -180,
      180,
      48
    ),
    shadowDistanceRatio: clampRange(parsed.shadowDistanceRatio, 0, 0.08, 0.016),
    shadowBlurRatio: clampRange(parsed.shadowBlurRatio, 0.003, 0.08, 0.024),
    shadowOpacity: clampRange(parsed.shadowOpacity, 0.08, 0.6, 0.22),
    preserveForegroundOccluders:
      parsed.preserveForegroundOccluders !== false &&
      String(parsed.preserveForegroundOccluders || '').trim().toLowerCase() !== 'false',
  };
};

const analyzeReferencePlacementWithAi = async ({ referenceImage, promptText = '' }) => {
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
  const completion = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Return STRICT JSON with keys: centerX, centerY, widthRatio, heightRatio, rotationDeg, anchorX, anchorY, anchorPoint, placementScale, supportSurface, contactEdge, shadowDirectionDeg, shadowDistanceRatio, shadowBlurRatio, shadowOpacity, preserveForegroundOccluders. ' +
          'Find the exact hero-product replacement area in the reference image. Target the old product itself, not surrounding accessories, logos, or empty scene space. ' +
          'All coordinates must be normalized between 0 and 1. ' +
          'widthRatio and heightRatio describe the replacement bounding box for the new product. ' +
          'rotationDeg should reflect the angle of the product in the scene if any. ' +
          'anchorX and anchorY must describe the main contact point where the new product should sit on the support surface. ' +
          'anchorPoint must be one of: center, bottom-center, top-center, mid-right, mid-left, bottom-right, bottom-left. ' +
          'Use center when the product is lying on a surface; use bottom-center when it is standing upright. ' +
          'placementScale should stay close to 1.0 and only exceed 1.0 when the new product should fill the replacement box more tightly. ' +
          'supportSurface should briefly name the visible surface under the product, such as striped beach chair, sand, tray, or pedestal. ' +
          'contactEdge should briefly describe which side of the product touches the surface. ' +
          'shadowDirectionDeg, shadowDistanceRatio, shadowBlurRatio, and shadowOpacity should describe the visible grounding shadow in the scene. ' +
          'If small foreground props overlap the original product, such as sunglasses or leaves, set preserveForegroundOccluders to true so the new product can stay aligned underneath them. ' +
          'Prefer the existing product position when one is visible. No extra keys.'
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Reference image for scene placement. User prompt: ${String(promptText || '')}` },
          { type: 'image_url', image_url: { url: referenceImage } },
        ],
      },
    ],
  });

  const raw = getMessageText(completion.choices?.[0]?.message).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse reference placement response');
  }
  return normalizeReferencePlacement(parsed);
};

const analyzeReferencePlacementWithGemini = async ({ referenceImage, promptText = '' }) => {
  const payload = parseDataUrl(referenceImage);
  if (!payload?.buffer) {
    throw new Error('Invalid reference image format for Gemini placement analysis');
  }

  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini placement analysis');
  }

  const geminiVisionModels = buildGeminiModelFallbackList([
    String(process.env.GEMINI_VISION_MODEL || '').trim(),
    String(process.env.GEMINI_TEXT_MODEL || '').trim(),
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    String(process.env.GEMINI_MODEL || '').trim(),
  ]);

  const placementPrompt =
    'Return STRICT JSON with keys: centerX, centerY, widthRatio, heightRatio, rotationDeg, anchorX, anchorY, anchorPoint, placementScale, supportSurface, contactEdge, shadowDirectionDeg, shadowDistanceRatio, shadowBlurRatio, shadowOpacity, preserveForegroundOccluders. ' +
    'Find the exact hero-product replacement area in the reference image. Target the old product itself, not surrounding props or empty sand. ' +
    'The output is for placing a new product in the same slot after the scene is regenerated. ' +
    'All coordinates are normalized 0 to 1. No markdown, JSON only.';

  const { response, model } = await postGeminiWithModelFallback({
    models: geminiVisionModels,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: `${placementPrompt} User prompt context: ${String(promptText || '') || 'none'}.`,
            },
            {
              inline_data: {
                data: payload.buffer.toString('base64'),
                mime_type: payload.mimeType,
              },
            },
          ],
        },
      ],
    },
    purpose: 'Reference placement analysis',
  });
  logInfo('Gemini', 'Reference placement analyzed', `model=${model}`);

  const raw = extractGeminiText(response.data).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse Gemini reference placement');
  }
  return normalizeReferencePlacement(parsed);
};

const analyzeReferencePlacementHybrid = async ({ referenceImage, promptText = '' }) => {
  const [openAiResult, geminiResult] = await Promise.allSettled([
    analyzeReferencePlacementWithAi({ referenceImage, promptText }),
    analyzeReferencePlacementWithGemini({ referenceImage, promptText }),
  ]);

  const openAiPlacement = openAiResult.status === 'fulfilled' ? openAiResult.value : null;
  const geminiPlacement = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

  if (!openAiPlacement && !geminiPlacement) {
    throw new Error(
      `Hybrid placement analysis failed. OpenAI: ${openAiResult.reason?.message || 'unknown'}. Gemini: ${geminiResult.reason?.message || 'unknown'}.`
    );
  }

  if (openAiResult.status === 'rejected') {
    logWarn('OpenAI', 'Reference placement failed', openAiResult.reason?.message || 'Unknown error');
  }
  if (geminiResult.status === 'rejected') {
    logWarn('Gemini', 'Reference placement failed', geminiResult.reason?.message || 'Unknown error');
  }

  return mergeReferencePlacements(openAiPlacement, geminiPlacement);
};

const normalizeReferenceSceneBlueprint = (parsed = {}) => ({
  sceneBlueprint: String(parsed?.sceneBlueprint || '').trim(),
  productAreaNotes: String(parsed?.productAreaNotes || '').trim(),
  cleanupNotes: String(parsed?.cleanupNotes || '').trim(),
  qualityNotes: String(parsed?.qualityNotes || '').trim(),
});

const analyzeReferenceSceneBlueprintWithAi = async ({
  referenceImage,
  promptText = '',
  requestedAspectRatio = '',
}) => {
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
  const completion = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Return STRICT JSON with keys: sceneBlueprint, productAreaNotes, cleanupNotes, qualityNotes. ' +
          'Describe the reference scene as a clean ad-ready composition blueprint that can be regenerated from text only. ' +
          'sceneBlueprint must describe the camera angle, environment, prop layout, relative positions, lighting direction, and shadows. ' +
          'productAreaNotes must describe exactly where the hero product sits and what support/surface it rests on. ' +
          'cleanupNotes must mention source-only artifacts to remove or avoid such as logos, timestamps, playback controls, watermarks, or the old product identity. ' +
          'qualityNotes must describe how to keep the recreated scene sharp, crisp, photorealistic, and free of blur or compression artifacts. ' +
          'Do not mention any unknown text literally unless clearly visible. Keep each field concise but specific.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Analyze this reference image and convert it into a clean regeneration blueprint. ` +
              `Requested aspect ratio: ${String(requestedAspectRatio || '') || 'unknown'}. ` +
              `User prompt context: ${String(promptText || '') || 'none'}.`,
          },
          { type: 'image_url', image_url: { url: referenceImage } },
        ],
      },
    ],
  });

  const raw = getMessageText(completion.choices?.[0]?.message).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse reference scene blueprint response');
  }

  const normalized = normalizeReferenceSceneBlueprint(parsed);
  if (!normalized.sceneBlueprint) {
    throw new Error('Reference scene blueprint was empty');
  }
  return normalized;
};

const normalizeReferenceScenePlan = (parsed = {}) => ({
  sceneBlueprint: String(parsed?.sceneBlueprint || parsed?.scene_blueprint || '').trim(),
  productAreaNotes: String(parsed?.productAreaNotes || parsed?.product_area_notes || '').trim(),
  cleanupNotes: String(parsed?.cleanupNotes || parsed?.cleanup_notes || '').trim(),
  qualityNotes: String(parsed?.qualityNotes || parsed?.quality_notes || '').trim(),
  surfaceMaterial: String(parsed?.surfaceMaterial || parsed?.surface_material || '').trim(),
  lightingDirection: String(parsed?.lightingDirection || parsed?.lighting_direction || '').trim(),
  depthOfField: String(parsed?.depthOfField || parsed?.depth_of_field || '').trim(),
  backgroundPrompt: String(parsed?.backgroundPrompt || parsed?.background_prompt || '').trim(),
  displayText: String(parsed?.displayText || parsed?.display_text || '').trim(),
  placement: normalizeReferencePlacement(parsed?.placement || parsed || {}),
});

const REFERENCE_SCENE_PLAN_PROMPT =
  'Return STRICT JSON with keys: sceneBlueprint, productAreaNotes, cleanupNotes, qualityNotes, surfaceMaterial, lightingDirection, depthOfField, backgroundPrompt, displayText, placement. ' +
  'placement must be an object with keys: centerX, centerY, widthRatio, heightRatio, rotationDeg, anchorX, anchorY, anchorPoint, placementScale, supportSurface, contactEdge, shadowDirectionDeg, shadowDistanceRatio, shadowBlurRatio, shadowOpacity, preserveForegroundOccluders. ' +
  'Analyze the reference image as a product-ad scene that will be fully regenerated and then receive a new uploaded product in the same hero slot. ' +
  'sceneBlueprint must describe camera angle, environment, prop layout, relative positions, lighting direction, foreground foliage, and shadows. ' +
  'productAreaNotes must describe exactly where the hero product sits, what surface it rests on, and any overlapping props or occluders nearby. ' +
  'cleanupNotes must mention source-only artifacts to remove or avoid such as logos, timestamps, playback controls, watermarks, or the old product identity. ' +
  'qualityNotes must state how to keep the regenerated scene sharp, photorealistic, premium, and free of blur or smeared details. ' +
  'Reference Image Context Extraction rules: ' +
  'surfaceMaterial must describe the dominant support material and texture under/around the hero slot (examples: wet sand, brushed metal table, matte stone slab, wood grain). ' +
  'lightingDirection must state where the key light comes from and the shadow travel direction (examples: upper-left sunlight casting shadows to lower-right). ' +
  'depthOfField must describe focus behavior of the scene (examples: deep focus across frame, shallow focus with soft background falloff). ' +
  'backgroundPrompt must be a vivid background-only regeneration prompt for the same scene with the old product removed. ' +
  'displayText must be one short plain-English summary sentence for UI display. ' +
  'placement must target the exact old product slot, not empty space. All coordinates are normalized 0 to 1. No markdown, no extra keys.';

const mergeDistinctSentences = (...values) => {
  const seen = new Set();
  const output = [];
  for (const rawValue of values) {
    const text = String(rawValue || '').trim();
    if (!text) {
      continue;
    }
    const parts = text
      .split(/(?<=[.!?])\s+/)
      .map((item) => item.trim())
      .filter(Boolean);
    for (const part of parts) {
      const key = part.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      output.push(part);
    }
  }
  return output.join(' ').trim();
};

const preferLongerText = (...values) =>
  values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)[0] || '';

const averageIfFinite = (...values) => {
  const numeric = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (!numeric.length) {
    return null;
  }
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
};

const mergeReferencePlacements = (primaryPlacement, secondaryPlacement) => {
  if (!primaryPlacement && !secondaryPlacement) {
    return normalizeReferencePlacement({});
  }
  if (!primaryPlacement) {
    return normalizeReferencePlacement(secondaryPlacement);
  }
  if (!secondaryPlacement) {
    return normalizeReferencePlacement(primaryPlacement);
  }

  const mergedRotationDeg = averageIfFinite(primaryPlacement.rotationDeg, secondaryPlacement.rotationDeg);
  const merged = {
    centerX: averageIfFinite(primaryPlacement.centerX, secondaryPlacement.centerX),
    centerY: averageIfFinite(primaryPlacement.centerY, secondaryPlacement.centerY),
    widthRatio: averageIfFinite(primaryPlacement.widthRatio, secondaryPlacement.widthRatio),
    heightRatio: averageIfFinite(primaryPlacement.heightRatio, secondaryPlacement.heightRatio),
    rotationDeg: mergedRotationDeg,
    anchorX: averageIfFinite(primaryPlacement.anchorX, secondaryPlacement.anchorX),
    anchorY: averageIfFinite(primaryPlacement.anchorY, secondaryPlacement.anchorY),
    anchorPoint:
      primaryPlacement.anchorPoint === secondaryPlacement.anchorPoint
        ? primaryPlacement.anchorPoint
        : (Math.abs(Number(mergedRotationDeg || 0)) >= 18 ? 'center' : primaryPlacement.anchorPoint || secondaryPlacement.anchorPoint),
    placementScale: averageIfFinite(primaryPlacement.placementScale, secondaryPlacement.placementScale),
    supportSurface: preferLongerText(primaryPlacement.supportSurface, secondaryPlacement.supportSurface),
    contactEdge: preferLongerText(primaryPlacement.contactEdge, secondaryPlacement.contactEdge),
    shadowDirectionDeg: averageIfFinite(primaryPlacement.shadowDirectionDeg, secondaryPlacement.shadowDirectionDeg),
    shadowDistanceRatio: averageIfFinite(primaryPlacement.shadowDistanceRatio, secondaryPlacement.shadowDistanceRatio),
    shadowBlurRatio: averageIfFinite(primaryPlacement.shadowBlurRatio, secondaryPlacement.shadowBlurRatio),
    shadowOpacity: averageIfFinite(primaryPlacement.shadowOpacity, secondaryPlacement.shadowOpacity),
    preserveForegroundOccluders:
      Boolean(primaryPlacement.preserveForegroundOccluders) || Boolean(secondaryPlacement.preserveForegroundOccluders),
  };

  return normalizeReferencePlacement(merged);
};

const mergeReferenceScenePlans = (primaryPlan, secondaryPlan) => {
  if (!primaryPlan && !secondaryPlan) {
    return normalizeReferenceScenePlan({});
  }
  if (!primaryPlan) {
    return normalizeReferenceScenePlan(secondaryPlan);
  }
  if (!secondaryPlan) {
    return normalizeReferenceScenePlan(primaryPlan);
  }

  return normalizeReferenceScenePlan({
    sceneBlueprint: mergeDistinctSentences(primaryPlan.sceneBlueprint, secondaryPlan.sceneBlueprint),
    productAreaNotes: mergeDistinctSentences(primaryPlan.productAreaNotes, secondaryPlan.productAreaNotes),
    cleanupNotes: mergeDistinctSentences(primaryPlan.cleanupNotes, secondaryPlan.cleanupNotes),
    qualityNotes: mergeDistinctSentences(primaryPlan.qualityNotes, secondaryPlan.qualityNotes),
    surfaceMaterial: preferLongerText(primaryPlan.surfaceMaterial, secondaryPlan.surfaceMaterial),
    lightingDirection: preferLongerText(primaryPlan.lightingDirection, secondaryPlan.lightingDirection),
    depthOfField: preferLongerText(primaryPlan.depthOfField, secondaryPlan.depthOfField),
    backgroundPrompt: mergeDistinctSentences(primaryPlan.backgroundPrompt, secondaryPlan.backgroundPrompt),
    displayText: preferLongerText(primaryPlan.displayText, secondaryPlan.displayText),
    placement: mergeReferencePlacements(primaryPlan.placement, secondaryPlan.placement),
  });
};

const buildReferencePromptBundleFromMergedPlan = ({
  mergedPlan,
  promptText = '',
  requestedAspectRatio = '',
  generationVariant = '',
}) => {
  const normalizedPlan = normalizeReferenceScenePlan(mergedPlan || {});
  const variant = String(generationVariant || '').trim().toLowerCase() || 'reference_exact';
  const placement = normalizedPlan.placement || normalizeReferencePlacement({});
  const placementText =
    `Hero slot center ${placement.centerX.toFixed(3)}, ${placement.centerY.toFixed(3)} with width ${placement.widthRatio.toFixed(3)}, height ${placement.heightRatio.toFixed(3)}, rotation ${placement.rotationDeg.toFixed(1)} degrees. ` +
    `${placement.supportSurface ? `Support surface: ${placement.supportSurface}. ` : ''}` +
    `${placement.contactEdge ? `Contact edge: ${placement.contactEdge}. ` : ''}` +
    `${placement.preserveForegroundOccluders ? 'Keep nearby foreground occluders aligned with the hero slot. ' : ''}`;
  const sharpnessGuard =
    'CRITICAL QUALITY: keep the final image crisp, high-detail, and photorealistic. ' +
    'Avoid haze, heavy bokeh blur, painterly softness, smearing, or low-resolution textures. ' +
    'Preserve clean edges and fine texture detail in foreground and midground elements.';
  const referenceContextExtractionText = mergeDistinctSentences(
    `Reference Image Context Extraction:`,
    normalizedPlan.surfaceMaterial ? `Surface material: ${normalizedPlan.surfaceMaterial}.` : '',
    normalizedPlan.lightingDirection ? `Lighting direction: ${normalizedPlan.lightingDirection}.` : '',
    normalizedPlan.depthOfField ? `Depth of field: ${normalizedPlan.depthOfField}.` : ''
  );

  const backgroundPrompt = mergeDistinctSentences(
    normalizedPlan.backgroundPrompt,
    `Regenerate the same premium advertising scene from the reference with the old hero product removed.`,
    normalizedPlan.sceneBlueprint ? `Scene blueprint: ${normalizedPlan.sceneBlueprint}.` : '',
    referenceContextExtractionText,
    normalizedPlan.cleanupNotes ? `Remove or avoid: ${normalizedPlan.cleanupNotes}.` : '',
    normalizedPlan.qualityNotes ? `Quality target: ${normalizedPlan.qualityNotes}.` : '',
    sharpnessGuard,
    placementText,
    `Variant: ${variant}.`,
    requestedAspectRatio ? `Aspect ratio: ${requestedAspectRatio}.` : '',
    promptText ? `User prompt context: ${promptText}.` : ''
  );

  const scenePrompt = mergeDistinctSentences(
    backgroundPrompt,
    `Place the uploaded product into the same hero slot and keep its placement physically grounded in the regenerated scene.`,
    normalizedPlan.productAreaNotes ? `Product area notes: ${normalizedPlan.productAreaNotes}.` : '',
    sharpnessGuard,
    referenceContextExtractionText
  );

  return normalizeReferenceGenerationPromptBundle({
    backgroundPrompt,
    scenePrompt,
    displayText:
      normalizedPlan.displayText ||
      'Reference-guided regenerated scene with the new product placed in the original hero slot.',
  });
};

const analyzeReferenceScenePlanWithAi = async ({
  referenceImage,
  promptText = '',
  requestedAspectRatio = '',
}) => {
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
  const completion = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: REFERENCE_SCENE_PLAN_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `Analyze this reference image for full-scene regeneration with exact hero-slot replacement. ` +
              `Requested aspect ratio: ${String(requestedAspectRatio || '') || 'unknown'}. ` +
              `User prompt context: ${String(promptText || '') || 'none'}.`,
          },
          { type: 'image_url', image_url: { url: referenceImage } },
        ],
      },
    ],
  });

  const raw = getMessageText(completion.choices?.[0]?.message).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse OpenAI reference scene plan');
  }
  return normalizeReferenceScenePlan(parsed);
};

const analyzeReferenceScenePlanWithGemini = async ({
  referenceImage,
  promptText = '',
  requestedAspectRatio = '',
}) => {
  const payload = parseDataUrl(referenceImage);
  if (!payload?.buffer) {
    throw new Error('Invalid reference image format for Gemini scene plan');
  }

  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for Gemini scene plan analysis');
  }

  const geminiVisionModels = buildGeminiModelFallbackList([
    String(process.env.GEMINI_VISION_MODEL || '').trim(),
    String(process.env.GEMINI_TEXT_MODEL || '').trim(),
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    String(process.env.GEMINI_MODEL || '').trim(),
  ]);

  const { response, model } = await postGeminiWithModelFallback({
    models: geminiVisionModels,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `${REFERENCE_SCENE_PLAN_PROMPT} ` +
                `Requested aspect ratio: ${String(requestedAspectRatio || '') || 'unknown'}. ` +
                `User prompt context: ${String(promptText || '') || 'none'}. ` +
                'Return JSON only.',
            },
            {
              inline_data: {
                data: payload.buffer.toString('base64'),
                mime_type: payload.mimeType,
              },
            },
          ],
        },
      ],
    },
    purpose: 'Reference scene plan analysis',
  });
  logInfo('Gemini', 'Reference scene plan analyzed', `model=${model}`);

  const raw = extractGeminiText(response.data).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse Gemini reference scene plan');
  }
  return normalizeReferenceScenePlan(parsed);
};

const analyzeReferenceScenePlanHybrid = async ({
  referenceImage,
  promptText = '',
  requestedAspectRatio = '',
  generationVariant = '',
}) => {
  const [openAiResult, geminiResult] = await Promise.allSettled([
    analyzeReferenceScenePlanWithAi({
      referenceImage,
      promptText,
      requestedAspectRatio,
    }),
    analyzeReferenceScenePlanWithGemini({
      referenceImage,
      promptText,
      requestedAspectRatio,
    }),
  ]);

  const openAiPlan = openAiResult.status === 'fulfilled' ? openAiResult.value : null;
  const geminiPlan = geminiResult.status === 'fulfilled' ? geminiResult.value : null;

  if (!openAiPlan && !geminiPlan) {
    throw new Error(
      `Hybrid reference analysis failed. OpenAI: ${openAiResult.reason?.message || 'unknown'}. Gemini: ${geminiResult.reason?.message || 'unknown'}.`
    );
  }

  if (openAiResult.status === 'rejected') {
    logWarn('OpenAI', 'Reference scene plan failed', openAiResult.reason?.message || 'Unknown error');
  }
  if (geminiResult.status === 'rejected') {
    logWarn('Gemini', 'Reference scene plan failed', geminiResult.reason?.message || 'Unknown error');
  }

  const mergedPlan = mergeReferenceScenePlans(openAiPlan, geminiPlan);
  const promptBundle = buildReferencePromptBundleFromMergedPlan({
    mergedPlan,
    promptText,
    requestedAspectRatio,
    generationVariant,
  });

  return {
    mergedPlan,
    openAiPlan,
    geminiPlan,
    promptBundle,
  };
};

const normalizeReferenceGenerationPromptBundle = (parsed = {}) => ({
  backgroundPrompt: String(parsed?.backgroundPrompt || '').trim(),
  scenePrompt: String(parsed?.scenePrompt || '').trim(),
  displayText: String(parsed?.displayText || '').trim(),
});

const buildReferenceGenerationPromptWithAi = async ({
  productImage,
  referenceImage,
  promptText = '',
  requestedAspectRatio = '',
  generationVariant = '',
}) => {
  const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
  const normalizedVariant = String(generationVariant || '').trim().toLowerCase() || 'reference_exact';
  const completion = await openai.chat.completions.create({
    model: openaiModel,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'Return STRICT JSON with keys: backgroundPrompt, scenePrompt, displayText. ' +
          'You are building a production-ready image prompt for ad generation. ' +
          'backgroundPrompt must be a full, vivid, highly specific prompt that recreates the reference scene cleanly but WITHOUT the old product, logos, UI overlays, timestamps, watermarks, playback controls, or text. ' +
          'scenePrompt must describe that same scene WITH the new uploaded product replacing the old hero product in the correct placement and scale. ' +
          'displayText must be a short plain-English one-sentence summary for UI display, not marketing copy. ' +
          'Both backgroundPrompt and scenePrompt must explicitly include a "Reference Image Context Extraction" section with three hooks: ' +
          'surface material under/around the hero slot, lighting direction with shadow travel, and depth of field characteristics. ' +
          'These hooks must be inferred from the reference image and expressed as concise scene constraints, so the workflow remains universal across any environment. ' +
          'Write concrete visual details from the image, not vague style words. ' +
          'Avoid mentioning blur, screenshot artifacts, compression, or low quality except to explicitly exclude them. ' +
          'Make the prompts photorealistic, sharp, premium, and ad-ready. No markdown, no extra keys.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              `User prompt context: ${String(promptText || '') || 'none'}. ` +
              `Target aspect ratio: ${String(requestedAspectRatio || '') || 'unknown'}. ` +
              `Variant: ${normalizedVariant}. ` +
              `If variant is reference_exact, stay very close to the original scene composition and camera angle. ` +
              `If variant is reference_creative, keep the same scene identity but allow tasteful cleanup and stronger commercial polish.`,
          },
          { type: 'text', text: 'New product image to feature:' },
          { type: 'image_url', image_url: { url: productImage } },
          { type: 'text', text: 'Reference image to study and reinterpret:' },
          { type: 'image_url', image_url: { url: referenceImage } },
        ],
      },
    ],
  });

  const raw = getMessageText(completion.choices?.[0]?.message).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed) {
    throw new Error('Failed to parse reference generation prompt response');
  }

  const normalized = normalizeReferenceGenerationPromptBundle(parsed);
  if (!normalized.backgroundPrompt && !normalized.scenePrompt) {
    throw new Error('Reference generation prompt was empty');
  }
  return normalized;
};

const resolveReferencePlacementAnchor = (referencePlacement, overlayWidth, overlayHeight) => {
  const point = String(referencePlacement?.anchorPoint || '').trim().toLowerCase();
  switch (point) {
    case 'bottom-center':
      return { x: overlayWidth * 0.5, y: overlayHeight * 0.94 };
    case 'top-center':
      return { x: overlayWidth * 0.5, y: overlayHeight * 0.08 };
    case 'mid-right':
      return { x: overlayWidth * 0.84, y: overlayHeight * 0.56 };
    case 'mid-left':
      return { x: overlayWidth * 0.16, y: overlayHeight * 0.56 };
    case 'bottom-right':
      return { x: overlayWidth * 0.8, y: overlayHeight * 0.86 };
    case 'bottom-left':
      return { x: overlayWidth * 0.2, y: overlayHeight * 0.86 };
    case 'center':
    default:
      return { x: overlayWidth * 0.5, y: overlayHeight * 0.5 };
  }
};

const SHOULD_ADD_SYNTHETIC_PLACEMENT_SHADOW =
  String(process.env.REFERENCE_OVERLAY_ENABLE_SYNTHETIC_SHADOW || 'false').toLowerCase() === 'true';
const DEFAULT_CENTER_OVERLAY_MAX_RATIO = (() => {
  const parsed = Number(process.env.DEFAULT_CENTER_OVERLAY_MAX_RATIO || '0.72');
  if (!Number.isFinite(parsed)) {
    return 0.72;
  }
  return Math.min(0.9, Math.max(0.45, parsed));
})();
const DEFAULT_CENTER_OVERLAY_VERTICAL_ANCHOR = (() => {
  const parsed = Number(process.env.DEFAULT_CENTER_OVERLAY_VERTICAL_ANCHOR || '0.56');
  if (!Number.isFinite(parsed)) {
    return 0.56;
  }
  return Math.min(0.72, Math.max(0.45, parsed));
})();
const SHOULD_ADD_CENTER_CONTACT_SHADOW =
  String(process.env.REFERENCE_OVERLAY_ENABLE_CENTER_SHADOW || 'true').toLowerCase() !== 'false';

const compositeProductOntoBackground = async ({
  backgroundBase64,
  sourceBuffer,
  referencePlacement,
  scaleMultiplier = 1,
}) => {
  if (!backgroundBase64 || !sourceBuffer) {
    return backgroundBase64;
  }

  const backgroundBuffer = Buffer.from(backgroundBase64, 'base64');
  const bgMeta = await sharp(backgroundBuffer).metadata();
  const bgWidth = bgMeta.width || 1024;
  const bgHeight = bgMeta.height || 1024;
  const preparedSourceBuffer = await sanitizeCutoutBufferForComposite(sourceBuffer);

  const trimmed = await sharp(preparedSourceBuffer)
    .ensureAlpha()
    .trim()
    .toBuffer({ resolveWithObject: true });

  let overlayBuffer = trimmed.data;
  let overlayWidth = trimmed.info.width;
  let overlayHeight = trimmed.info.height;
  let left = 0;
  let top = 0;
  const compositeLayers = [];

  if (referencePlacement) {
    const effectiveScaleMultiplier = Math.max(
      0.6,
      scaleMultiplier * Number(referencePlacement.placementScale || 1)
    );
    const targetPlacementWidth = Math.max(
      1,
      Math.round(bgWidth * referencePlacement.widthRatio * effectiveScaleMultiplier)
    );
    const targetPlacementHeight = Math.max(
      1,
      Math.round(bgHeight * referencePlacement.heightRatio * effectiveScaleMultiplier)
    );
    const placementScale = Math.min(
      targetPlacementWidth / overlayWidth,
      targetPlacementHeight / overlayHeight
    );

    overlayWidth = Math.max(1, Math.round(overlayWidth * placementScale));
    overlayHeight = Math.max(1, Math.round(overlayHeight * placementScale));
    const rotatedOverlay = await sharp(overlayBuffer)
      .resize(overlayWidth, overlayHeight, { fit: 'inside' })
      .rotate(referencePlacement.rotationDeg || 0, {
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .toBuffer({ resolveWithObject: true });

    overlayWidth = rotatedOverlay.info.width;
    overlayHeight = rotatedOverlay.info.height;
    overlayBuffer = rotatedOverlay.data;

    const overlayAnchor = resolveReferencePlacementAnchor(referencePlacement, overlayWidth, overlayHeight);
    const anchorX = Math.round(bgWidth * (referencePlacement.anchorX ?? referencePlacement.centerX));
    const anchorY = Math.round(bgHeight * (referencePlacement.anchorY ?? referencePlacement.centerY));
    left = Math.max(0, Math.min(bgWidth - overlayWidth, Math.round(anchorX - overlayAnchor.x)));
    top = Math.max(0, Math.min(bgHeight - overlayHeight, Math.round(anchorY - overlayAnchor.y)));

    const shadowOpacity = SHOULD_ADD_SYNTHETIC_PLACEMENT_SHADOW
      ? Number(referencePlacement.shadowOpacity || 0)
      : 0;
    if (shadowOpacity > 0.01) {
      const shadowBlurPx = Math.max(
        0.6,
        Math.round(Math.max(bgWidth, bgHeight) * Number(referencePlacement.shadowBlurRatio || 0))
      );
      const shadowDistancePx = Math.round(
        Math.max(bgWidth, bgHeight) * Number(referencePlacement.shadowDistanceRatio || 0)
      );
      const shadowDirectionRad = (Number(referencePlacement.shadowDirectionDeg || 0) * Math.PI) / 180;
      const shadowLeft = Math.max(
        0,
        Math.min(
          bgWidth - overlayWidth,
          left + Math.round(Math.cos(shadowDirectionRad) * shadowDistancePx)
        )
      );
      const shadowTop = Math.max(
        0,
        Math.min(
          bgHeight - overlayHeight,
          top + Math.round(Math.sin(shadowDirectionRad) * shadowDistancePx)
        )
      );
      const ambientShadow = await sharp(overlayBuffer)
        .ensureAlpha()
        .linear([0, 0, 0, shadowOpacity * 0.72], [0, 0, 0, 0])
        .blur(shadowBlurPx)
        .toBuffer();
      const contactShadow = await sharp(overlayBuffer)
        .ensureAlpha()
        .linear([0, 0, 0, Math.min(0.6, shadowOpacity * 1.18)], [0, 0, 0, 0])
        .blur(Math.max(0.8, shadowBlurPx * 0.32))
        .toBuffer();
      compositeLayers.push({ input: ambientShadow, left: shadowLeft, top: shadowTop });
      compositeLayers.push({ input: contactShadow, left, top });
    }
  } else {
    const maxOverlayWidth = Math.round(bgWidth * DEFAULT_CENTER_OVERLAY_MAX_RATIO);
    const maxOverlayHeight = Math.round(bgHeight * DEFAULT_CENTER_OVERLAY_MAX_RATIO);
    const scale = Math.min(
      1,
      maxOverlayWidth / overlayWidth,
      maxOverlayHeight / overlayHeight
    );

    if (scale < 1) {
      overlayWidth = Math.round(overlayWidth * scale);
      overlayHeight = Math.round(overlayHeight * scale);
      overlayBuffer = await sharp(overlayBuffer)
        .resize(overlayWidth, overlayHeight, { fit: 'inside' })
        .toBuffer();
    }

    left = Math.round((bgWidth - overlayWidth) / 2);
    const centerAnchorY = Math.round(bgHeight * DEFAULT_CENTER_OVERLAY_VERTICAL_ANCHOR);
    top = Math.max(0, Math.min(bgHeight - overlayHeight, Math.round(centerAnchorY - (overlayHeight / 2))));

    if (SHOULD_ADD_CENTER_CONTACT_SHADOW) {
      const shadowWidth = Math.max(10, Math.round(overlayWidth * 0.74));
      const shadowHeight = Math.max(8, Math.round(overlayHeight * 0.13));
      const shadowLeft = Math.max(0, Math.min(bgWidth - shadowWidth, left + Math.round((overlayWidth - shadowWidth) / 2)));
      const shadowTop = Math.max(
        0,
        Math.min(bgHeight - shadowHeight, top + overlayHeight - Math.round(shadowHeight * 0.55))
      );
      const shadowSvg = `
        <svg width="${shadowWidth}" height="${shadowHeight}" xmlns="http://www.w3.org/2000/svg">
          <ellipse cx="${Math.round(shadowWidth * 0.5)}" cy="${Math.round(shadowHeight * 0.56)}" rx="${Math.round(shadowWidth * 0.48)}" ry="${Math.round(shadowHeight * 0.42)}" fill="rgba(0,0,0,0.20)" />
          <ellipse cx="${Math.round(shadowWidth * 0.5)}" cy="${Math.round(shadowHeight * 0.62)}" rx="${Math.round(shadowWidth * 0.36)}" ry="${Math.round(shadowHeight * 0.28)}" fill="rgba(0,0,0,0.26)" />
        </svg>
      `;
      const shadowLayer = await sharp(Buffer.from(shadowSvg))
        .blur(Math.max(0.8, shadowHeight * 0.22))
        .png()
        .toBuffer();
      compositeLayers.push({ input: shadowLayer, left: shadowLeft, top: shadowTop });
    }
  }
  compositeLayers.push({ input: overlayBuffer, left, top });

  const composited = await sharp(backgroundBuffer)
    .resize(bgWidth, bgHeight, { fit: 'cover' })
    .composite(compositeLayers)
    .png()
    .toBuffer();

  return composited.toString('base64');
};

const handleAnalyzeApi = async (req, res) => {
  const imageData = req.body?.productImage || req.body?.referenceImage;
  const provider = String(req.body?.provider || 'gemini').trim().toLowerCase();
  const policyContext =
    req?.projectApiPolicy && typeof req.projectApiPolicy === 'object'
      ? req.projectApiPolicy
      : null;

  if (!imageData) {
    return res.status(400).json({ error: 'Product image is required' });
  }
  if (provider !== 'gemini' && provider !== 'openai') {
    return res.status(400).json({ error: 'Provider must be gemini or openai' });
  }

  const imagePayload = parseDataUrl(imageData);
  if (!imagePayload) {
    return res.status(400).json({ error: 'Invalid image format' });
  }

  try {
    const analyzed = provider === 'openai'
      ? await analyzeReferenceImageWithAi(imageData)
      : await analyzeReferenceImageWithGemini(imageData);
    if (provider === 'openai') {
      return res.json({
        ...analyzed,
        analysisMeta: {
          provider: 'openai',
          pipelineName: PIPELINE_NAME_OPENAI_ANALYZE,
          qualityScore: undefined,
          gatePassed: undefined,
          retryCount: undefined,
          failureReasons: undefined,
          requestedPipeline: policyContext?.requestedPipeline || undefined,
          effectivePipeline: policyContext?.effectivePipeline || PIPELINE_NAME_OPENAI_ANALYZE,
          overrideRejected: policyContext?.overrideRejected === true,
          rejectionReason: policyContext?.rejectionReason || undefined,
        },
      });
    }
    if (analyzed && typeof analyzed === 'object' && analyzed.analysisMeta && typeof analyzed.analysisMeta === 'object') {
      analyzed.analysisMeta = {
        ...analyzed.analysisMeta,
        requestedPipeline: policyContext?.requestedPipeline || undefined,
        effectivePipeline:
          policyContext?.effectivePipeline ||
          analyzed.analysisMeta.pipelineName ||
          PIPELINE_NAME_GEMINI_EDIT,
        overrideRejected: policyContext?.overrideRejected === true,
        rejectionReason: policyContext?.rejectionReason || undefined,
      };
    }
    return res.json(analyzed);
  } catch (error) {
    const errorData = error.response?.data;
    const geminiDetails = error?.details || error?.cause?.details || null;
    const errorDetails =
      errorData?.error?.message ||
      errorData?.error ||
      geminiDetails?.data?.error?.message ||
      geminiDetails?.data?.error ||
      errorData ||
      error.message;
    const errorTextRaw =
      typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails);
    const errorText =
      geminiDetails?.attempted && !String(errorTextRaw || '').includes('Gemini endpoints:')
        ? `${errorTextRaw} (Gemini endpoints: ${geminiDetails.attempted})`
        : errorTextRaw;
    const upstreamStatus = getUpstreamHttpStatus(error);
    const responseStatus = mapUpstreamStatusToClientStatus(upstreamStatus);
    const responseDetails =
      responseStatus === 503
        ? `${errorText} (upstream service unavailable, please retry)`
        : errorText;
    console.error('Error analyzing image:', errorText);
    return res.status(responseStatus).json({
      error: 'Analysis failed',
      details: responseDetails,
      upstreamStatus: upstreamStatus || undefined,
    });
  }
};

app.post('/api/analyze', requireAuth, handleAnalyzeApi);

app.post('/api/video/render', requireAuth, async (req, res) => {
  const imageUrl = String(req.body?.imageUrl || '').trim();
  const presetModeRaw = String(req.body?.presetMode || VIDEO_PRESET_MODES.AUTO).trim().toLowerCase();
  const meta = req.body?.meta && typeof req.body.meta === 'object' ? req.body.meta : {};
  const headline = String(req.body?.headline || '').trim();
  const themeHints = String(req.body?.themeHints || '').trim();
  const useGeminiMotion = req.body?.useGeminiMotion !== false;

  if (!isValidVideoImageUrl(imageUrl)) {
    return res.status(400).json({ error: 'imageUrl must be a valid data URL, absolute URL, or root-relative URL' });
  }

  const normalizedPresetMode = MANUAL_PRESET_VALUES.has(presetModeRaw) || presetModeRaw === VIDEO_PRESET_MODES.AUTO
    ? presetModeRaw
    : VIDEO_PRESET_MODES.AUTO;

  try {
    const job = enqueueVideoRenderJob({
      userId: req.user?.id || '',
      imageUrl,
      presetMode: normalizedPresetMode,
      meta,
      headline,
      themeHints,
      useGeminiMotion,
    });

    return res.status(202).json({
      jobId: job.jobId,
      status: job.status,
    });
  } catch (error) {
    return res.status(500).json({
      error: 'Failed to enqueue video render job',
      details: error.message || 'Unknown error',
    });
  }
});

app.get('/api/video/render/:jobId', requireAuth, async (req, res) => {
  const jobId = String(req.params?.jobId || '').trim();
  if (!jobId) {
    return res.status(400).json({ error: 'jobId is required' });
  }

  const job = videoRenderJobs.get(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Video render job not found' });
  }

  if (String(job.userId || '') !== String(req.user?.id || '')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (job.status === 'completed') {
    return res.json({
      jobId,
      status: 'completed',
      videoUrl: job.videoUrl,
      durationSec: Number(job.durationSec || 6),
      presetUsed: job.presetUsed,
      analysisMode: job.analysisMode || 'basic',
      geminiAnalysis: job.geminiAnalysis || null,
      remotionInstruction: job.remotionInstruction || null,
    });
  }

  if (job.status === 'failed') {
    return res.json({
      jobId,
      status: 'failed',
      error: job.error || 'Video render failed',
      analysisMode: job.analysisMode || 'basic',
      geminiAnalysis: job.geminiAnalysis || null,
      remotionInstruction: job.remotionInstruction || null,
    });
  }

  return res.json({
    jobId,
    status: job.status,
    progress: Number(job.progress || 0),
    analysisMode: job.analysisMode || 'basic',
    geminiAnalysis: job.geminiAnalysis || null,
    remotionInstruction: job.remotionInstruction || null,
  });
});

app.post('/api/reference/test-read', requireAuth, async (req, res) => {
  const referenceImage = req.body?.referenceImage;
  const provider = String(req.body?.provider || '').trim().toLowerCase();
  const promptText = String(req.body?.promptText || '').trim();
  const requestedAspectRatio = String(req.body?.requestedAspectRatio || '').trim();
  const generationVariant = String(req.body?.generationVariant || 'reference_exact').trim() || 'reference_exact';

  if (!referenceImage) {
    return res.status(400).json({ error: 'Reference image is required' });
  }
  if (provider !== 'openai' && provider !== 'gemini') {
    return res.status(400).json({ error: 'Provider must be openai or gemini' });
  }

  const imagePayload = parseDataUrl(referenceImage);
  if (!imagePayload?.buffer) {
    return res.status(400).json({ error: 'Invalid reference image format' });
  }

  try {
    const scenePlan =
      provider === 'gemini'
        ? await analyzeReferenceScenePlanWithGemini({
            referenceImage,
            promptText,
            requestedAspectRatio,
          })
        : await analyzeReferenceScenePlanWithAi({
            referenceImage,
            promptText,
            requestedAspectRatio,
          });

    const promptBundle = buildReferencePromptBundleFromMergedPlan({
      mergedPlan: scenePlan,
      promptText,
      requestedAspectRatio,
      generationVariant,
    });

    return res.json({
      provider,
      scenePlan,
      promptBundle,
      builtPrompt: promptBundle.scenePrompt || promptBundle.backgroundPrompt || '',
    });
  } catch (error) {
    const errorData = error.response?.data;
    const geminiDetails = error?.details || error?.cause?.details || null;
    const errorDetails =
      errorData?.error?.message ||
      errorData?.error ||
      geminiDetails?.data?.error?.message ||
      geminiDetails?.data?.error ||
      errorData ||
      error.message;
    const errorTextRaw =
      typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails);
    const errorText =
      geminiDetails?.attempted && !String(errorTextRaw || '').includes('Gemini endpoints:')
        ? `${errorTextRaw} (Gemini endpoints: ${geminiDetails.attempted})`
        : errorTextRaw;
    const upstreamStatus = getUpstreamHttpStatus(error);
    const responseStatus = mapUpstreamStatusToClientStatus(upstreamStatus);
    const responseDetails =
      responseStatus === 503
        ? `${errorText} (upstream service unavailable, please retry)`
        : errorText;

    console.error('Error in /api/reference/test-read:', errorText);
    return res.status(responseStatus).json({
      error: 'Reference analysis test failed',
      details: responseDetails,
      upstreamStatus: upstreamStatus || undefined,
    });
  }
});

const parseDataUrl = (dataUrl) => {
  if (typeof dataUrl !== 'string') {
    return null;
  }
  if (!dataUrl.startsWith('data:')) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    return null;
  }
  const header = dataUrl.slice(0, commaIndex);
  const base64Data = dataUrl.slice(commaIndex + 1);
  if (!header.includes(';base64')) {
    return null;
  }
  const mimeType = header.replace(/^data:/, '').replace(/;base64$/i, '');
  const normalized = base64Data.replace(/\s/g, '');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  return {
    mimeType,
    buffer: Buffer.from(padded, 'base64'),
  };
};

const toTelegramId = (ctx) => String(ctx?.from?.id || '').trim();
const isValidEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
const BOT_STATE_IDLE = 'IDLE';
const BOT_STATE_AWAITING_REGISTRATION_EMAIL = 'AWAITING_REGISTRATION_EMAIL';
const BOT_STATE_AWAITING_EMAIL_VERIFICATION = 'AWAITING_EMAIL_VERIFICATION';
const BOT_STATE_AWAITING_REGISTRATION_PHONE = 'AWAITING_REGISTRATION_PHONE';
const BOT_STATE_AWAITING_PLAN_SELECTION = 'AWAITING_PLAN_SELECTION';
const TELEGRAM_SESSION_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const BOT_STATE_WIZARD_WAITING_REFERENCE = 'WIZARD_WAITING_REFERENCE';
const BOT_STATE_WIZARD_MODE_SELECT = 'WIZARD_MODE_SELECT';
const BOT_STATE_SIMPLE_REFERENCE_DECISION = 'SIMPLE_REFERENCE_DECISION';
const BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE = 'SIMPLE_WAITING_REFERENCE_IMAGE';
const BOT_STATE_WIZARD_READY = 'WIZARD_READY';
const ALLOWED_CTA_VALUES = ['Shop Now', 'Buy Now', 'Learn More', 'Get Offer', 'Order Today'];
const TELEGRAM_WIZARD_TOTAL_STEPS = 13;
const TELEGRAM_WIZARD_STEPS = [
  {
    state: 'WIZARD_PRODUCT_FOCUS',
    key: 'product_focus',
    label: 'Product focus',
    prompt: 'Step 2/13: Product focus',
    help: 'Type the exact product name/variant.',
    options: ['Mulberry ITRA', 'Premium Perfume', 'Luxury Serum'],
  },
  {
    state: 'WIZARD_MAIN_THEME',
    key: 'main_theme',
    label: 'Main theme',
    prompt: 'Step 3/13: Main element / theme',
    help: 'Example: mulberry, rose petals, ocean wave.',
    options: ['Mulberry', 'Rose', 'Minimal Luxury'],
  },
  {
    state: 'WIZARD_VISUAL_MOOD',
    key: 'visual_mood',
    label: 'Visual mood',
    prompt: 'Step 4/13: Visual mood',
    help: 'Example: cinematic, premium, energetic.',
    options: ['Cinematic', 'Premium', 'Dynamic'],
  },
  {
    state: 'WIZARD_DYNAMIC_ELEMENTS',
    key: 'dynamic_elements',
    label: 'Dynamic elements',
    prompt: 'Step 5/13: Dynamic elements',
    help: 'Example: splash, particles, smoke.',
    options: ['Splash', 'Mist + particles', 'Clean (none)'],
  },
  {
    state: 'WIZARD_COLOR_PALETTE',
    key: 'color_palette',
    label: 'Color palette',
    prompt: 'Step 6/13: Color palette',
    help: 'Example: red/black/white.',
    options: ['Red, Black, White', 'Gold, Black', 'Soft Pastel'],
  },
  {
    state: 'WIZARD_BACKGROUND_ENVIRONMENT',
    key: 'background_environment',
    label: 'Background environment',
    prompt: 'Step 7/13: Background environment',
    help: 'Example: transparent studio, luxury podium, nature backdrop.',
    options: ['Transparent style studio', 'Luxury podium', 'Nature backdrop'],
  },
  {
    state: 'WIZARD_BRAND_TEXT_OVERLAY',
    key: 'brand_name',
    label: 'Brand text',
    prompt: 'Step 8/13: Brand text',
    help: 'Type the brand text for the image (example: Strawberry Noir), or type none.',
    options: ['Strawberry Noir', 'Mulberry ITRA', 'None'],
  },
  {
    state: 'WIZARD_LIGHTING',
    key: 'lighting',
    label: 'Lighting',
    prompt: 'Step 9/13: Lighting',
    help: 'Example: cinematic, softbox, dramatic rim.',
    options: ['Cinematic', 'Softbox', 'Studio clean'],
  },
  {
    state: 'WIZARD_FORMAT',
    key: 'format',
    label: 'Format',
    prompt: 'Step 10/13: Format',
    help: 'Example: 1:1, 4:5, 9:16.',
    options: ['1:1', '4:5', '9:16'],
  },
  {
    state: 'WIZARD_CTA',
    key: 'cta',
    label: 'Call to action',
    prompt: 'Step 11/13: Call to action text',
    help: 'Type CTA text, or type none.',
    options: ['None', ...ALLOWED_CTA_VALUES],
  },
  {
    state: 'WIZARD_ADDITIONAL_DIRECTIVES',
    key: 'additional_directives',
    label: 'Additional directives',
    prompt: 'Step 12/13: Additional directives',
    help: 'AI will decide this automatically. Type your own text to override, or type skip.',
    options: [],
  },
  {
    state: 'WIZARD_BRAND_LOGO',
    key: 'brand_logo_file',
    label: 'Brand logo (optional)',
    prompt: 'Step 13/13: Brand logo (optional)',
    help: 'Send your brand logo as a PNG document/file, or type skip.',
    options: ['Skip'],
  },
];

const TELEGRAM_WIZARD_STEP_BY_STATE = Object.fromEntries(
  TELEGRAM_WIZARD_STEPS.map((step) => [step.state, step])
);
const TELEGRAM_WIZARD_STATE_SET = new Set(TELEGRAM_WIZARD_STEPS.map((step) => step.state));

const normalizeBotState = (value) => {
  const normalized = String(value || BOT_STATE_IDLE).toUpperCase();
  if (normalized === 'AWAITING_EMAIL' || normalized === 'AWAITING_NAME') {
    return BOT_STATE_AWAITING_REGISTRATION_EMAIL;
  }
  if (normalized === 'AWAITING_EMAIL_VERIFICATION' || normalized === 'AWAITING_OTP') {
    return BOT_STATE_AWAITING_EMAIL_VERIFICATION;
  }
  if (normalized === 'AWAITING_PHONE' || normalized === 'AWAITING_CONTACT') {
    return BOT_STATE_AWAITING_REGISTRATION_PHONE;
  }
  if (normalized === 'AWAITING_PLAN' || normalized === 'PLAN_SELECTION') {
    return BOT_STATE_AWAITING_PLAN_SELECTION;
  }
  return normalized;
};

const normalizePhoneNumber = (value) => {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }
  const cleaned = raw.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return cleaned.slice(0, 20);
};

const isValidPhoneNumber = (value) => /^[+]?\d{7,15}$/.test(String(value || '').trim());
const getUserPhone = (user) => normalizePhoneNumber(user?.bot_data?.phone || '');
const needsPhoneRegistration = (user) => !isValidPhoneNumber(getUserPhone(user));
const getUserBotDataObject = (user) =>
  user?.bot_data && typeof user.bot_data === 'object' ? user.bot_data : {};
const getEmailVerificationRecord = (user) => {
  const botData = getUserBotDataObject(user);
  const record = botData?.email_verification;
  if (!record || typeof record !== 'object') {
    return null;
  }
  const pendingEmail = String(record.pending_email || '').trim().toLowerCase();
  const codeHash = String(record.code_hash || '').trim();
  const expiresAt = String(record.expires_at || '').trim();
  const targetUserId = String(record.target_user_id || '').trim() || null;
  const attempts = Number(record.attempts || 0);
  if (!pendingEmail || !codeHash || !expiresAt) {
    return null;
  }
  return {
    pendingEmail,
    codeHash,
    expiresAt,
    targetUserId,
    attempts: Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0,
  };
};
const isEmailVerificationRecordValid = (record) => {
  if (!record) {
    return false;
  }
  const expiresAtMs = new Date(record.expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > Date.now();
};
const getRegistrationStateForUser = (user) => {
  if (
    normalizeBotState(user?.bot_state) === BOT_STATE_AWAITING_PLAN_SELECTION &&
    normalizePlanTier(user?.plan_tier) === 'free'
  ) {
    return BOT_STATE_AWAITING_PLAN_SELECTION;
  }
  const pendingVerification = getEmailVerificationRecord(user);
  if (isEmailVerificationRecordValid(pendingVerification)) {
    return BOT_STATE_AWAITING_EMAIL_VERIFICATION;
  }
  if (!isValidEmail(user?.email)) {
    return BOT_STATE_AWAITING_REGISTRATION_EMAIL;
  }
  if (needsPhoneRegistration(user)) {
    return BOT_STATE_AWAITING_REGISTRATION_PHONE;
  }
  return BOT_STATE_IDLE;
};
const isRegistrationPendingState = (botState) =>
  botState === BOT_STATE_AWAITING_REGISTRATION_EMAIL ||
  botState === BOT_STATE_AWAITING_EMAIL_VERIFICATION ||
  botState === BOT_STATE_AWAITING_REGISTRATION_PHONE;
const maskEmailAddress = (email) => {
  const value = String(email || '').trim();
  const at = value.indexOf('@');
  if (at <= 1) {
    return value;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain) {
    return value;
  }
  const localMasked = `${local.slice(0, 1)}${'*'.repeat(Math.max(1, local.length - 2))}${local.slice(-1)}`;
  return `${localMasked}@${domain}`;
};

const sanitizeUsernameCandidate = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);

const buildTelegramUsernameCandidates = (ctx, telegramId) => {
  const from = ctx?.from || {};
  const displayFromName = [from.first_name, from.last_name]
    .filter(Boolean)
    .join('_');
  const candidates = [
    sanitizeUsernameCandidate(from.username),
    sanitizeUsernameCandidate(displayFromName),
    sanitizeUsernameCandidate(from.first_name),
    sanitizeUsernameCandidate(`tg_${telegramId}`),
  ].filter(Boolean);
  return [...new Set(candidates)];
};

const findAvailableUsername = async (client, candidates, fallbackSeed) => {
  const candidateList = [...new Set(candidates.filter(Boolean))];
  const fallback = sanitizeUsernameCandidate(fallbackSeed) || `tg_${Date.now().toString(36)}`;
  if (!candidateList.length) {
    candidateList.push(fallback);
  }

  for (const baseValue of candidateList) {
    const base = sanitizeUsernameCandidate(baseValue) || fallback;
    for (let index = 0; index < 50; index += 1) {
      const suffix = index === 0 ? '' : `_${index + 1}`;
      const maxBaseLength = Math.max(1, 64 - suffix.length);
      const username = `${base.slice(0, maxBaseLength)}${suffix}`;
      const exists = await client.query(
        `
          SELECT 1
          FROM users
          WHERE username = $1
          LIMIT 1
        `,
        [username]
      );
      if (!exists.rowCount) {
        return username;
      }
    }
  }

  return `tg_${Date.now().toString(36)}`.slice(0, 64);
};

const extractStartPayloadEmail = (ctx) => {
  const rawText = String(ctx?.message?.text || '').trim();
  if (!rawText) {
    return '';
  }
  const payload = rawText.split(/\s+/).slice(1).join(' ').trim();
  if (!payload) {
    return '';
  }

  const possibleValues = [
    payload,
    payload.replace(/^email=/i, ''),
  ]
    .map((item) => {
      try {
        return decodeURIComponent(item);
      } catch (error) {
        return item;
      }
    })
    .map((item) => item.trim().toLowerCase());

  return possibleValues.find((value) => isValidEmail(value)) || '';
};

const createTelegramSessionTx = async (client, userId, telegramId) => {
  const expiresAt = new Date(Date.now() + TELEGRAM_SESSION_DURATION_MS);
  let insertedSession = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const tokenHash = crypto
      .createHash('sha256')
      .update(`${crypto.randomBytes(32).toString('hex')}:${Date.now()}:${userId}:${attempt}`)
      .digest('hex');
    try {
      const inserted = await client.query(
        `
          INSERT INTO user_sessions (user_id, session_token_hash, expires_at, user_agent)
          VALUES ($1, $2, $3, $4)
          RETURNING id, session_token_hash, expires_at, created_at
        `,
        [userId, tokenHash, expiresAt, 'telegram-bot']
      );
      insertedSession = inserted.rows[0] || null;
      break;
    } catch (error) {
      if (error?.code === '23505') {
        continue;
      }
      throw error;
    }
  }

  if (!insertedSession) {
    throw new Error('Could not generate a unique Telegram session token');
  }

  const sessionPayload = {
    session_id: insertedSession.id,
    session_token_hash: insertedSession.session_token_hash,
    source: 'telegram',
    telegram_id: String(telegramId || ''),
    created_at: insertedSession.created_at,
    expires_at: insertedSession.expires_at,
  };

  await client.query(
    `
      UPDATE users
      SET last_login_at = NOW(),
          bot_data = jsonb_set(COALESCE(bot_data, '{}'::jsonb), '{telegram_session}', $2::jsonb, true),
          updated_at = NOW()
      WHERE id = $1
    `,
    [userId, JSON.stringify(sessionPayload)]
  );

  return insertedSession;
};

const scheduleTelegramProfileSync = (userId, telegramId, from) => {
  const firstName = String(from?.first_name || '').trim();
  const lastName = String(from?.last_name || '').trim();
  const handle = String(from?.username || '').trim();

  setImmediate(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        `
          SELECT id, username
          FROM users
          WHERE id = $1
          LIMIT 1
          FOR UPDATE
        `,
        [userId]
      );
      if (!userResult.rowCount) {
        await client.query('ROLLBACK');
        return;
      }

      const currentUser = userResult.rows[0];
      const currentUsername = String(currentUser.username || '');
      const isPlaceholderUsername = /^tg_\d+$/i.test(currentUsername);

      let nextUsername = null;
      if (isPlaceholderUsername) {
        const preferredCandidates = [
          sanitizeUsernameCandidate([firstName, lastName].filter(Boolean).join('_')),
          sanitizeUsernameCandidate(handle),
        ].filter(Boolean);
        if (preferredCandidates.length) {
          nextUsername = await findAvailableUsername(client, preferredCandidates, `tg_${telegramId}`);
        }
      }

      const profilePayload = {
        first_name: firstName || null,
        last_name: lastName || null,
        telegram_username: handle || null,
        synced_at: new Date().toISOString(),
      };

      await client.query(
        `
          UPDATE users
          SET username = COALESCE($2, username),
              bot_data = jsonb_set(COALESCE(bot_data, '{}'::jsonb), '{telegram_profile}', $3::jsonb, true),
              updated_at = NOW()
          WHERE id = $1
        `,
        [userId, nextUsername, JSON.stringify(profilePayload)]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.warn('Telegram profile sync failed:', error.message);
    } finally {
      client.release();
    }
  });
};

const normalizeTelegramTopupCredits = (value) => {
  const parsed = Math.floor(Number(value));
  const fallbackCredits = getDefaultTopupPackageCredits();
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackCredits;
  }
  const matched = findTopupPackageByCredits(parsed);
  if (matched && matched.isActive !== false) {
    return Math.floor(Number(matched.credits));
  }
  return fallbackCredits;
};

const getTelegramTopupPriceCents = (creditsToAdd) => {
  const safeCredits = Math.max(1, Math.floor(Number(creditsToAdd) || getDefaultTopupPackageCredits()));
  const configured = findTopupPackageByCredits(safeCredits);
  const priceUsd = configured
    ? Number(configured.priceUsd || 0)
    : Number((TELEGRAM_TOPUP_UNIT_PRICE_USD * safeCredits).toFixed(2));
  return Math.max(50, Math.round(Math.max(0, priceUsd) * 100));
};

const formatUsdFromCents = (amountCents) => `$${(Math.max(0, Number(amountCents) || 0) / 100).toFixed(2)}`;

const getTelegramTopupPackOptions = () =>
  getActiveTopupPackages().map((pack) => {
    const credits = Math.max(1, Math.floor(Number(pack.credits || 0)));
    const amountCents = getTelegramTopupPriceCents(credits);
    return {
      credits,
      amountCents,
      priceLabel: formatUsdFromCents(amountCents),
    };
  });

const TELEGRAM_TOPUP_START_PARAM = 'topup_done';
const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
const normalizeTelegramStartParam = (value) =>
  String(value || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
const getTelegramBotUsername = () => String(process.env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
const buildTelegramBotStartUrl = (startParam = '') => {
  const username = getTelegramBotUsername();
  if (!username) {
    return '';
  }
  try {
    const url = new URL(`https://t.me/${username}`);
    const safeStartParam = normalizeTelegramStartParam(startParam);
    if (safeStartParam) {
      url.searchParams.set('start', safeStartParam);
    }
    return url.toString();
  } catch (error) {
    return '';
  }
};
const buildTelegramBotDeepLinkUrl = (startParam = '') => {
  const username = getTelegramBotUsername();
  if (!username) {
    return '';
  }
  try {
    const url = new URL('tg://resolve');
    url.searchParams.set('domain', username);
    const safeStartParam = normalizeTelegramStartParam(startParam);
    if (safeStartParam) {
      url.searchParams.set('start', safeStartParam);
    }
    return url.toString();
  } catch (error) {
    return '';
  }
};
const buildTelegramBotIntentUrl = (startParam = '') => {
  const username = getTelegramBotUsername();
  if (!username) {
    return '';
  }
  const safeStartParam = normalizeTelegramStartParam(startParam);
  const fallbackUrl = buildTelegramBotStartUrl(safeStartParam);
  const queryPairs = [`domain=${encodeURIComponent(username)}`];
  if (safeStartParam) {
    queryPairs.push(`start=${encodeURIComponent(safeStartParam)}`);
  }
  const fallbackPart = fallbackUrl
    ? `;S.browser_fallback_url=${encodeURIComponent(fallbackUrl)}`
    : '';
  return `intent://resolve?${queryPairs.join('&')}#Intent;scheme=tg;package=org.telegram.messenger${fallbackPart};end`;
};

const buildTelegramReturnUrl = () => {
  const startUrl = buildTelegramBotStartUrl('');
  if (startUrl) {
    return startUrl;
  }

  const candidates = [
    String(process.env.PAYMENT_REDIRECT_URL || '').trim(),
    String(process.env.CLIENT_BASE_URL || '').trim(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch (error) {
      // ignore invalid url candidate
    }
  }
  return 'https://telegram.org';
};

const buildPublicServerUrl = () => {
  const candidates = [
    String(process.env.TELEGRAM_PAYMENT_CALLBACK_BASE_URL || '').trim(),
    String(process.env.PUBLIC_SERVER_URL || '').trim(),
    String(process.env.CLIENT_BASE_URL || '').trim(),
    String(process.env.PAYMENT_REDIRECT_URL || '').trim(),
  ];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:') {
        return `${url.origin}`;
      }
    } catch (error) {
      // ignore invalid URL candidate
    }
  }
  return '';
};

const buildTelegramPaymentStatusRedirectUrl = (status, options = {}) => {
  const url = new URL(buildTelegramReturnUrl());
  url.searchParams.set('payment', String(status || 'unknown'));
  if (options.telegramId) {
    url.searchParams.set('telegram_id', String(options.telegramId));
  }
  if (Number.isFinite(Number(options.creditsAdded)) && Number(options.creditsAdded) > 0) {
    url.searchParams.set('credits_added', String(Math.floor(Number(options.creditsAdded))));
  }
  if (options.duplicate) {
    url.searchParams.set('duplicate', '1');
  }
  if (options.message) {
    url.searchParams.set('message', String(options.message).slice(0, 200));
  }
  return url.toString();
};

const renderTelegramTopupSuccessPage = (res, options = {}) => {
  const telegramId = String(options.telegramId || '').trim();
  const creditsAdded = Number(options.creditsAdded || 0);
  const duplicate = options.duplicate === true;
  const badgeText = String(options.badgeText || 'Payment Successful').slice(0, 80);
  const headline = String(options.headline || 'Top-up complete').slice(0, 120);
  const leadText = String(options.leadText || 'Your payment has been confirmed and your bot is ready.').slice(0, 220);
  const webStartUrl = buildTelegramBotStartUrl(TELEGRAM_TOPUP_START_PARAM)
    || buildTelegramPaymentStatusRedirectUrl('success', {
      telegramId,
      creditsAdded,
      duplicate,
    });
  const openButtonUrl = webStartUrl;
  const defaultDetailLine = duplicate
    ? 'Top-up already processed.'
    : (creditsAdded > 0 ? `Credits added: ${Math.floor(creditsAdded)}.` : 'Top-up processed.');
  const detailLine = String(options.detailLine || defaultDetailLine).slice(0, 220);
  const openButtonUrlSafe = escapeHtml(openButtonUrl);
  const detailLineSafe = escapeHtml(detailLine);
  const badgeTextSafe = escapeHtml(badgeText);
  const headlineSafe = escapeHtml(headline);
  const leadTextSafe = escapeHtml(leadText);

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Payment Successful</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Playfair+Display:wght@600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --landing-bg: #05070b;
      --landing-action-start: #1ddecf;
      --landing-action-end: #0a8780;
      --landing-gray-100: #e5e7eb;
      --landing-gray-300: #a1a1aa;
      --landing-glass: rgba(255, 255, 255, 0.05);
      --landing-halo-purple: rgba(150, 130, 255, 0.26);
      --landing-halo-teal: rgba(29, 222, 203, 0.32);
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 20px 16px;
      font-family: "Inter", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 14% 16%, rgba(29, 222, 203, 0.17), transparent 35%),
        radial-gradient(circle at 82% 24%, rgba(150, 130, 255, 0.15), transparent 34%),
        linear-gradient(170deg, #04060a 0%, #060b12 55%, #05070b 100%);
      color: var(--landing-gray-100);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .shell {
      width: 100%;
      max-width: 560px;
      position: relative;
    }
    .shell::before {
      content: "";
      position: absolute;
      inset: -24% -12%;
      background:
        radial-gradient(circle at 30% 35%, var(--landing-halo-teal), transparent 40%),
        radial-gradient(circle at 70% 60%, var(--landing-halo-purple), transparent 44%);
      filter: blur(22px);
      opacity: 0.9;
      pointer-events: none;
      z-index: 0;
    }
    .card {
      position: relative;
      z-index: 1;
      width: 100%;
      border-radius: 24px;
      border: 1px solid rgba(255, 255, 255, 0.11);
      background: linear-gradient(160deg, rgba(15, 22, 34, 0.72), rgba(8, 12, 20, 0.86));
      backdrop-filter: blur(18px);
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.12),
        0 26px 60px rgba(0, 0, 0, 0.45);
      padding: 24px 20px 20px;
      overflow: hidden;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 14px;
    }
    .brand {
      font-family: "Playfair Display", Georgia, serif;
      font-size: 1.12rem;
      letter-spacing: 0.02em;
      color: #e7edf7;
      margin: 0;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 7px 12px;
      border-radius: 999px;
      background: linear-gradient(120deg, rgba(29, 222, 203, 0.22), rgba(10, 135, 128, 0.24));
      color: #b8fff7;
      border: 1px solid rgba(29, 222, 203, 0.32);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .hero {
      margin-top: 8px;
    }
    h1 {
      margin: 8px 0 10px;
      font-size: clamp(1.65rem, 5vw, 2.05rem);
      line-height: 1.18;
      letter-spacing: -0.02em;
      color: #f1f5fb;
    }
    .lead {
      margin: 0 0 12px;
      color: #d8dee8;
      font-size: 1.03rem;
      line-height: 1.55;
    }
    .meta {
      margin: 0 0 16px;
      color: #9db0c5;
      font-size: 0.92rem;
      line-height: 1.45;
    }
    .meta-chip {
      display: inline-flex;
      align-items: center;
      padding: 7px 11px;
      border-radius: 11px;
      border: 1px solid rgba(144, 226, 218, 0.28);
      background: rgba(20, 42, 51, 0.42);
      color: #c7f6f2;
      font-size: 0.88rem;
      font-weight: 600;
    }
    .btn {
      display: block;
      width: 100%;
      text-align: center;
      margin-top: 12px;
      padding: 14px 16px;
      border-radius: 14px;
      background: linear-gradient(135deg, var(--landing-action-start), var(--landing-action-end));
      color: #022b30;
      text-decoration: none;
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.01em;
      box-shadow: 0 14px 30px rgba(10, 135, 128, 0.4);
      transition: transform 180ms ease, box-shadow 180ms ease, filter 180ms ease;
    }
    .btn:active {
      transform: translateY(1px) scale(0.996);
    }
    .btn-secondary {
      background: rgba(255, 255, 255, 0.09);
      color: #e6edf6;
      border: 1px solid rgba(255, 255, 255, 0.16);
      box-shadow: none;
      margin-top: 8px;
    }
    .muted {
      margin-top: 14px;
      font-size: 13px;
      color: var(--landing-gray-300);
      line-height: 1.45;
      text-align: center;
    }
    .card-glow {
      pointer-events: none;
      position: absolute;
      inset: auto -25% -35% -25%;
      height: 220px;
      background: radial-gradient(circle, rgba(29, 222, 203, 0.22) 0%, rgba(29, 222, 203, 0) 64%);
      filter: blur(18px);
      z-index: 0;
    }
    @media (min-width: 520px) {
      body {
        padding: 28px;
      }
      .card {
        padding: 28px 26px 22px;
      }
      .btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 18px 36px rgba(10, 135, 128, 0.45);
        filter: brightness(1.03);
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <main class="card">
      <div class="topbar">
        <p class="brand">AdReady</p>
        <div class="badge">${badgeTextSafe}</div>
      </div>
      <section class="hero">
        <h1>${headlineSafe}</h1>
        <p class="lead">${leadTextSafe}</p>
        <p class="meta"><span class="meta-chip">${detailLineSafe}</span></p>
      </section>
      <a id="open-telegram-btn" class="btn" href="${openButtonUrlSafe}">Open Telegram</a>
      <a id="go-back-btn" class="btn btn-secondary" href="#">Go Back</a>
      <p class="muted">If you remain on this page, tap Go Back or close from the top-left button.</p>
      <div class="card-glow" aria-hidden="true"></div>
    </main>
  </div>
  <script>
    (function () {
      var backButton = document.getElementById('go-back-btn');

      function tryBackNavigation() {
        try {
          if (window.history.length > 1) {
            window.history.back();
            return;
          }
        } catch (error) {
          // ignore and try close fallback
        }
        try {
          window.close();
        } catch (error) {
          // ignore
        }
      }
      if (backButton) {
        backButton.addEventListener('click', function (event) {
          event.preventDefault();
          tryBackNavigation();
        });
      }
    })();
  </script>
</body>
</html>`;

  return res
    .status(200)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    .send(html);
};

const buildTelegramPaymentCallbackUrl = (type, telegramId) => {
  const serverBaseUrl = buildPublicServerUrl();
  if (!serverBaseUrl) {
    return '';
  }
  try {
    const base = new URL(serverBaseUrl).origin;
    const safeTelegramId = encodeURIComponent(String(telegramId || '').trim());
    if (type === 'success') {
      // Keep the placeholder unencoded so Stripe can replace it.
      return `${base}/api/telegram/payment/success?telegram_id=${safeTelegramId}&session_id={CHECKOUT_SESSION_ID}`;
    }
    return `${base}/api/telegram/payment/cancel?telegram_id=${safeTelegramId}`;
  } catch (error) {
    return '';
  }
};

const applyTelegramTopupCredits = async ({
  telegramId,
  creditsToAdd,
  sessionId,
  source = 'stripe',
  notifyUser = true,
}) => {
  const normalizedTelegramId = String(telegramId || '').trim();
  const normalizedSessionId = String(sessionId || '').trim();
  const parsedCredits = Number(creditsToAdd);
  const safeCredits = normalizeTelegramTopupCredits(parsedCredits);

  if (!normalizedTelegramId) {
    return { ok: false, applied: false, reason: 'missing_telegram_id' };
  }
  if (!normalizedSessionId) {
    return { ok: false, applied: false, reason: 'missing_session_id' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertedHistory = await client.query(
      `
        INSERT INTO stripe_topup_history (session_id, telegram_id, credits_added, source)
        VALUES ($1, $2::bigint, $3, $4)
        ON CONFLICT (session_id) DO NOTHING
        RETURNING session_id
      `,
      [normalizedSessionId, normalizedTelegramId, safeCredits, String(source || 'stripe').slice(0, 64)]
    );
    if (!insertedHistory.rowCount) {
      await client.query('ROLLBACK');
      return { ok: true, applied: false, duplicate: true, reason: 'duplicate_session' };
    }

    const userUpdate = await client.query(
      `
        UPDATE users
        SET credits = credits + $1,
            updated_at = NOW()
        WHERE telegram_id = $2::bigint
        RETURNING id, credits
      `,
      [safeCredits, normalizedTelegramId]
    );
    if (!userUpdate.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, applied: false, reason: 'user_not_found' };
    }

    await client.query('COMMIT');

    const balance = Number(userUpdate.rows[0].credits || 0);
    if (notifyUser && telegramBot) {
      try {
        await telegramBot.telegram.sendMessage(
          normalizedTelegramId,
          [
            '\u{2705} Payment Successful!',
            `\u{1F4B8} Added: ${safeCredits} Credits`,
            `\u{1F4B3} Wallet Balance: ${balance}`,
          ].join('\n')
        );
      } catch (notifyError) {
        console.warn('Failed to send Telegram payment confirmation:', notifyError.message);
      }
    }

    return {
      ok: true,
      applied: true,
      duplicate: false,
      creditsAdded: safeCredits,
      creditsBalance: balance,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};

const sendTelegramPlanActivatedMessage = async ({ telegramId, planTier, creditsBalance }) => {
  const normalizedTelegramId = String(telegramId || '').trim();
  if (!normalizedTelegramId || !telegramBot) {
    return;
  }
  const plan = getPlanConfig(planTier);
  try {
    await telegramBot.telegram.sendMessage(
      normalizedTelegramId,
      [
        '\u{2705} Subscription Activated!',
        `\u{1F4E6} Plan: ${plan.name}`,
        `\u{1F4B0} Monthly Credits: ${Math.floor(Number(plan.monthlyCredits || 0))}`,
        Number.isFinite(Number(creditsBalance))
          ? `\u{1F4B3} Wallet Balance: ${Math.floor(Number(creditsBalance))}`
          : '',
      ].filter(Boolean).join('\n')
    );
  } catch (notifyError) {
    console.warn('Failed to send Telegram plan activation confirmation:', notifyError.message);
  }
};

const createTelegramPlanCheckoutUrl = async ({
  telegramId,
  user,
  planTier,
}) => {
  if (!stripe) {
    return '';
  }
  const requestedPlanTier = normalizePlanTier(planTier);
  if (requestedPlanTier === 'free') {
    return '';
  }

  const plan = getPlanConfig(requestedPlanTier);
  const userId = String(user?.id || '').trim();
  const email = String(user?.email || '').trim();
  if (!userId || !email) {
    return '';
  }

  if (
    normalizePlanTier(user?.plan_tier) === requestedPlanTier &&
    String(user?.plan_status || '').toLowerCase() === 'active'
  ) {
    return '';
  }

  const fallbackReturnUrl = buildTelegramReturnUrl();
  const successUrl = buildTelegramPaymentCallbackUrl('success', telegramId) || (() => {
    const url = new URL(fallbackReturnUrl);
    url.searchParams.set('payment', 'success');
    url.searchParams.set('telegram_id', String(telegramId || ''));
    return url.toString();
  })();
  const cancelUrl = buildTelegramPaymentCallbackUrl('cancel', telegramId) || (() => {
    const url = new URL(fallbackReturnUrl);
    url.searchParams.set('payment', 'cancel');
    url.searchParams.set('telegram_id', String(telegramId || ''));
    return url.toString();
  })();

  const metadata = {
    source: 'telegram_bot_plan',
    user_id: userId,
    telegram_id: String(telegramId || ''),
    plan_tier: plan.tier,
    monthly_credit_quota: String(plan.monthlyCredits),
  };

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: user?.stripe_customer_id || undefined,
    customer_email: user?.stripe_customer_id ? undefined : email,
    client_reference_id: userId,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(Number(plan.priceUsdMonthly || 0) * 100),
          recurring: { interval: 'month' },
          product_data: {
            name: `AdReady ${plan.name} Plan`,
            description: `${Math.floor(Number(plan.monthlyCredits || 0))} credits per month`,
          },
        },
      },
    ],
    metadata,
    subscription_data: {
      metadata,
    },
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  if (checkoutSession.customer && !user?.stripe_customer_id) {
    await pool.query(
      `
        UPDATE users
        SET stripe_customer_id = $1
        WHERE id = $2
      `,
      [String(checkoutSession.customer), userId]
    );
  }

  return String(checkoutSession?.url || '');
};

const createTelegramTopupCheckoutUrl = async (telegramId, requestedCredits = getDefaultTopupPackageCredits()) => {
  if (!stripe) {
    return '';
  }
  const selectedCredits = normalizeTelegramTopupCredits(requestedCredits);
  const selectedAmountCents = getTelegramTopupPriceCents(selectedCredits);

  const fallbackReturnUrl = buildTelegramReturnUrl();
  const successUrl = buildTelegramPaymentCallbackUrl('success', telegramId) || (() => {
    const url = new URL(fallbackReturnUrl);
    url.searchParams.set('payment', 'success');
    url.searchParams.set('telegram_id', String(telegramId));
    return url.toString();
  })();
  const cancelUrl = buildTelegramPaymentCallbackUrl('cancel', telegramId) || (() => {
    const url = new URL(fallbackReturnUrl);
    url.searchParams.set('payment', 'cancel');
    url.searchParams.set('telegram_id', String(telegramId));
    return url.toString();
  })();

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: String(telegramId),
    metadata: {
      telegram_id: String(telegramId),
      credits_to_add: String(selectedCredits),
      source: 'telegram_bot',
    },
    payment_intent_data: {
      metadata: {
        telegram_id: String(telegramId),
        credits_to_add: String(selectedCredits),
        source: 'telegram_bot',
      },
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: selectedAmountCents,
          product_data: {
            name: `AdReady Credit Pack (${selectedCredits} credits)`,
            description: `Telegram top-up: ${selectedCredits} credits`,
          },
        },
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
  });

  return String(checkoutSession?.url || '');
};

const buildTelegramTopupButtonRows = async (telegramId) => {
  try {
    await syncTopupPackages({ force: true });
  } catch (error) {
    console.warn('Top-up package sync failed before building Telegram buttons:', error.message);
  }
  const packs = getTelegramTopupPackOptions();
  const packRows = await Promise.all(
    packs.map(async (pack) => {
      let checkoutUrl = '';
      try {
        checkoutUrl = await createTelegramTopupCheckoutUrl(telegramId, pack.credits);
      } catch (error) {
        console.warn(`Telegram Stripe checkout creation failed for ${pack.credits} credits:`, error.message);
      }
      if (!checkoutUrl) {
        return null;
      }
      const label = `\u{1F4B0} ${pack.credits} Credits (${pack.priceLabel})`;
      return [Markup.button.url(label, checkoutUrl)];
    })
  );
  return packRows.filter(Boolean);
};

const sendBuyPrompt = async (ctx, telegramId) => {
  const buttonRows = await buildTelegramTopupButtonRows(telegramId);
  if (!buttonRows.length) {
    await ctx.reply(
      'Payment is currently unavailable.\nConfigure Stripe keys and callback/public server URL, then restart the server.'
    );
    return;
  }
  await ctx.reply(
    '\u{1F6D2} Credits Required\nYour current balance is 0. Choose a top-up package to continue.',
    Markup.inlineKeyboard(buttonRows)
  );
};

const TELEGRAM_MENU_COMMANDS = [
  { command: 'start', description: 'Start or reconnect your account' },
  { command: 'signin', description: 'Sign in to your account' },
  { command: 'new', description: 'Start guided generation wizard' },
  { command: 'fill', description: 'Fill wizard fields with AI suggestions' },
  { command: 'generate', description: 'Generate image from wizard inputs' },
  { command: 'cancel', description: 'Cancel current wizard' },
  { command: 'credits', description: 'Check your current credits' },
  { command: 'buy', description: 'Buy credits' },
  { command: 'logout', description: 'Logout from Telegram bot' },
  { command: 'menu', description: 'Show available bot commands' },
  { command: 'help', description: 'How to use this bot' },
];

const sendGeneratedPhoto = async (ctx, imageUrl, captionText) => {
  const caption = String(captionText || 'Image processed successfully.').slice(0, 1000);
  const payload = parseDataUrl(imageUrl);
  const sendAsDocument = String(process.env.TELEGRAM_SEND_AS_DOCUMENT || 'false').toLowerCase() !== 'false';
  if (payload?.buffer) {
    if (sendAsDocument) {
      await ctx.replyWithDocument(
        { source: payload.buffer, filename: 'adready-output.png' },
        { caption }
      );
    } else {
      await ctx.replyWithPhoto(
        { source: payload.buffer, filename: 'adready-output.png' },
        { caption }
      );
    }
    return;
  }
  await ctx.replyWithPhoto(imageUrl, { caption });
};

const fetchRemoteImageAsDataUrl = async (imageUrl) => {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: TELEGRAM_IMAGE_FETCH_TIMEOUT_MS,
  });
  const buffer = Buffer.from(response.data);
  let mimeType = String(response.headers['content-type'] || '').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    try {
      const metadata = await sharp(buffer, { failOnError: false }).metadata();
      const format = String(metadata.format || '').toLowerCase();
      if (format === 'png') {
        mimeType = 'image/png';
      } else if (format === 'jpeg' || format === 'jpg') {
        mimeType = 'image/jpeg';
      } else if (format === 'webp') {
        mimeType = 'image/webp';
      } else if (format === 'gif') {
        mimeType = 'image/gif';
      } else {
        mimeType = 'image/jpeg';
      }
    } catch (error) {
      mimeType = 'image/jpeg';
    }
  }
  const base64 = buffer.toString('base64');
  return `data:${mimeType};base64,${base64}`;
};

const ensureImageDataUrlMime = async (dataUrl, fallbackMimeType = 'image/png') => {
  const payload = parseDataUrl(dataUrl);
  if (!payload?.buffer) {
    return dataUrl;
  }

  let mimeType = String(payload.mimeType || '').toLowerCase();
  if (!mimeType.startsWith('image/')) {
    try {
      const metadata = await sharp(payload.buffer, { failOnError: false }).metadata();
      const format = String(metadata.format || '').toLowerCase();
      if (format === 'png') {
        mimeType = 'image/png';
      } else if (format === 'jpeg' || format === 'jpg') {
        mimeType = 'image/jpeg';
      } else if (format === 'webp') {
        mimeType = 'image/webp';
      } else if (format === 'gif') {
        mimeType = 'image/gif';
      } else if (String(fallbackMimeType || '').toLowerCase().startsWith('image/')) {
        mimeType = String(fallbackMimeType).toLowerCase();
      } else {
        mimeType = 'image/png';
      }
    } catch (error) {
      mimeType = String(fallbackMimeType || '').toLowerCase().startsWith('image/')
        ? String(fallbackMimeType).toLowerCase()
        : 'image/png';
    }
  }

  return `data:${mimeType};base64,${payload.buffer.toString('base64')}`;
};

const resolveTelegramImageDataUrl = async ({
  telegramClient = null,
  fileId = '',
  fallbackUrl = '',
  fallbackMimeType = 'image/png',
  assetLabel = 'image',
}) => {
  const candidateUrls = [];
  const normalizedFileId = String(fileId || '').trim();
  const normalizedFallbackUrl = String(fallbackUrl || '').trim();
  if (normalizedFileId && telegramClient && typeof telegramClient.getFileLink === 'function') {
    try {
      const freshLink = await telegramClient.getFileLink(normalizedFileId);
      const freshUrl = String(freshLink || '').trim();
      if (freshUrl) {
        candidateUrls.push(freshUrl);
      }
    } catch (error) {
      console.warn(`Failed to refresh Telegram ${assetLabel} URL from file_id:`, error.message);
    }
  }
  if (normalizedFallbackUrl) {
    candidateUrls.push(normalizedFallbackUrl);
  }

  const dedupedUrls = Array.from(new Set(candidateUrls.filter(Boolean)));
  if (!dedupedUrls.length) {
    throw new Error(`${assetLabel} is missing. Please upload again.`);
  }

  let lastError = null;
  for (const url of dedupedUrls) {
    try {
      const dataUrlRaw = await fetchRemoteImageAsDataUrl(url);
      const dataUrl = await ensureImageDataUrlMime(dataUrlRaw, fallbackMimeType);
      return { dataUrl, resolvedUrl: url };
    } catch (error) {
      lastError = error;
    }
  }

  const status = Number(lastError?.response?.status || 0);
  if (status === 404) {
    throw new Error(`Stored ${assetLabel} link expired. Please upload the file again.`);
  }
  throw new Error(lastError?.message || `Failed to load ${assetLabel}`);
};

const inspectImageDataUrl = async (dataUrl) => {
  const payload = parseDataUrl(dataUrl);
  if (!payload?.buffer) {
    return {
      mimeType: '',
      hasAlphaChannel: false,
      hasTransparentPixels: false,
    };
  }

  try {
    const metadata = await sharp(payload.buffer).metadata();
    let hasTransparentPixels = false;
    if (metadata.hasAlpha) {
      const stats = await sharp(payload.buffer).stats();
      const alphaChannel = stats.channels?.[3];
      hasTransparentPixels = Boolean(alphaChannel && alphaChannel.min < 255);
    }
    const detectedFormat = String(metadata.format || '').toLowerCase();
    let normalizedMimeType = String(payload.mimeType || '').toLowerCase();
    if (!normalizedMimeType.startsWith('image/')) {
      if (detectedFormat === 'png') {
        normalizedMimeType = 'image/png';
      } else if (detectedFormat === 'jpeg' || detectedFormat === 'jpg') {
        normalizedMimeType = 'image/jpeg';
      } else if (detectedFormat === 'webp') {
        normalizedMimeType = 'image/webp';
      } else if (detectedFormat === 'gif') {
        normalizedMimeType = 'image/gif';
      }
    }

    return {
      mimeType: normalizedMimeType || payload.mimeType || '',
      hasAlphaChannel: Boolean(metadata.hasAlpha),
      hasTransparentPixels,
    };
  } catch (error) {
    return {
      mimeType: payload.mimeType || '',
      hasAlphaChannel: false,
      hasTransparentPixels: false,
    };
  }
};

const isPngMime = (mimeType) => String(mimeType || '').toLowerCase().includes('png');
const getFileExtension = (fileName) => {
  const name = String(fileName || '');
  const index = name.lastIndexOf('.');
  if (index < 0) {
    return '';
  }
  return name.slice(index).toLowerCase();
};

const getWizardStepByState = (state) => TELEGRAM_WIZARD_STEP_BY_STATE[String(state || '').toUpperCase()] || null;
const isWizardInputState = (state) => TELEGRAM_WIZARD_STATE_SET.has(String(state || '').toUpperCase());
const getNextWizardStepState = (state) => {
  const index = TELEGRAM_WIZARD_STEPS.findIndex((step) => step.state === String(state || '').toUpperCase());
  if (index < 0 || index === TELEGRAM_WIZARD_STEPS.length - 1) {
    return BOT_STATE_WIZARD_READY;
  }
  return TELEGRAM_WIZARD_STEPS[index + 1].state;
};
const getWizardStepProgressMeta = (state) => {
  const index = TELEGRAM_WIZARD_STEPS.findIndex((step) => step.state === String(state || '').toUpperCase());
  if (index < 0) {
    return null;
  }
  const stepNumber = index + 2;
  const completedCount = Math.max(1, stepNumber - 1);
  const clampedCompleted = Math.min(TELEGRAM_WIZARD_TOTAL_STEPS, completedCount);
  const progressBar =
    `${'\u{1F535}'.repeat(clampedCompleted)}${'\u{26AA}'.repeat(Math.max(0, TELEGRAM_WIZARD_TOTAL_STEPS - clampedCompleted))}`;
  return {
    stepNumber,
    totalSteps: TELEGRAM_WIZARD_TOTAL_STEPS,
    progressBar,
  };
};

const normalizeWizardValue = (rawValue) => {
  const text = String(rawValue || '').trim();
  if (!text) {
    return '';
  }
  const withoutSuggestionPrefix = text.replace(/^(?:>\s*)?(?:ai suggestion|example)\s*:\s*/i, '').trim();
  const normalizedText = withoutSuggestionPrefix || text;
  const lowered = normalizedText.toLowerCase();
  if (
    ['skip', 'none', 'no', 'n/a', '-'].includes(lowered) ||
    lowered.includes('skip')
  ) {
    return '';
  }
  return normalizedText.slice(0, 220);
};

const normalizeCtaChoice = (rawValue, fallback = '') => {
  const value = String(rawValue || '').trim();
  if (!value) {
    return fallback;
  }
  const lowered = value.toLowerCase();
  if (['none', 'no', 'skip', 'n/a', '-'].includes(lowered)) {
    return 'None';
  }
  const exact = ALLOWED_CTA_VALUES.find((item) => item.toLowerCase() === lowered);
  if (exact) {
    return exact;
  }

  const containsMap = [
    ['shop', 'Shop Now'],
    ['buy', 'Buy Now'],
    ['learn', 'Learn More'],
    ['offer', 'Get Offer'],
    ['order', 'Order Today'],
  ];
  for (const [needle, normalized] of containsMap) {
    if (lowered.includes(needle)) {
      return normalized;
    }
  }
  return fallback;
};

const normalizeCtaOptionList = (value) => {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/\s*\|\s*|\s*;\s*|\s*\/\s*|\s*,\s*/g);
  const unique = [];
  const seen = new Set();
  for (const itemRaw of values) {
    const normalized = normalizeCtaChoice(itemRaw, '');
    const key = normalized.toLowerCase();
    if (!normalized || normalized === 'None' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(normalized);
    if (unique.length >= 4) {
      break;
    }
  }
  return unique;
};

const extractRequestedCtaFromPrompt = (promptText) => {
  const text = String(promptText || '');
  const patterns = [
    /CTA text[^.]*EXACTLY\s+"([^"]+)"/i,
    /Target CTA for final render:\s*"([^"]+)"/i,
    /\bCTA(?:\s*for final render)?\s*:\s*([A-Za-z ]{2,60})/i,
    /Call to action(?: text)?\s*:\s*([A-Za-z ]{2,60})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const normalized = normalizeCtaChoice(match[1], '');
      if (normalized && normalized !== 'None') {
        return normalized;
      }
    }
  }
  return '';
};

const extractRequestedAspectRatioFromPrompt = (promptText) => {
  const text = String(promptText || '');
  const match = text.match(/\bAspect ratio:\s*(1:1|9:16|4:5|16:9)\b/i);
  return match?.[1] || '1:1';
};

const getCanvasDimensionsForAspectRatio = (aspectRatio) => {
  switch (String(aspectRatio || '1:1')) {
    case '4:5':
      return { width: 1024, height: 1280 };
    case '9:16':
      return { width: 1024, height: 1820 };
    case '16:9':
      return { width: 1280, height: 720 };
    case '1:1':
    default:
      return { width: 1024, height: 1024 };
  }
};

const prepareReferenceBackgroundBase = async (referenceBuffer, canvasDimensions) => {
  const targetWidth = canvasDimensions?.width || 1024;
  const targetHeight = canvasDimensions?.height || 1024;
  return sharp(referenceBuffer)
    .resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
};

const prepareExactReferenceBase = async (referenceBuffer, canvasDimensions) => {
  const targetWidth = canvasDimensions?.width || 1024;
  const targetHeight = canvasDimensions?.height || 1024;
  const metadata = await sharp(referenceBuffer).metadata();
  const sourceWidth = metadata.width || targetWidth;
  const sourceHeight = metadata.height || targetHeight;
  const cropTop = 0;
  const cropBottom = Math.min(
    Math.round(sourceHeight * 0.12),
    Math.max(0, sourceHeight - Math.round(sourceHeight * 0.78))
  );
  const extractHeight = Math.max(1, sourceHeight - cropTop - cropBottom);

  return sharp(referenceBuffer)
    .extract({ left: 0, top: cropTop, width: sourceWidth, height: extractHeight })
    .resize(targetWidth, targetHeight, { fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
};

const softenPlacementAreaOnReferenceBase = async (backgroundBuffer, referencePlacement) => {
  if (!backgroundBuffer || !referencePlacement) {
    return backgroundBuffer;
  }
  try {
    const baseMeta = await sharp(backgroundBuffer).metadata();
    const baseWidth = baseMeta.width || 1024;
    const baseHeight = baseMeta.height || 1024;
    const centerX = Number(referencePlacement.centerX ?? 0.5);
    const centerY = Number(referencePlacement.centerY ?? 0.5);
    const widthRatio = Number(referencePlacement.widthRatio ?? 0.34);
    const heightRatio = Number(referencePlacement.heightRatio ?? 0.48);

    const expandMultiplier = 1.22;
    const patchWidth = Math.max(12, Math.round(baseWidth * widthRatio * expandMultiplier));
    const patchHeight = Math.max(12, Math.round(baseHeight * heightRatio * expandMultiplier));
    const patchLeft = Math.max(
      0,
      Math.min(baseWidth - patchWidth, Math.round(baseWidth * centerX - patchWidth / 2))
    );
    const patchTop = Math.max(
      0,
      Math.min(baseHeight - patchHeight, Math.round(baseHeight * centerY - patchHeight / 2))
    );

    const blurSigma = Math.max(4, Math.round(Math.min(baseWidth, baseHeight) * 0.012));
    const blurred = await sharp(backgroundBuffer)
      .blur(blurSigma)
      .toBuffer();
    const blurredPatch = await sharp(blurred)
      .extract({
        left: patchLeft,
        top: patchTop,
        width: patchWidth,
        height: patchHeight,
      })
      .ensureAlpha()
      .linear([1, 1, 1, 0.62], [0, 0, 0, 0])
      .toBuffer();

    return sharp(backgroundBuffer)
      .composite([
        {
          input: blurredPatch,
          left: patchLeft,
          top: patchTop,
        },
      ])
      .png()
      .toBuffer();
  } catch (error) {
    logWarn('StrictLock', 'Placement-area soft clean failed; using original reference base', error.message);
    return backgroundBuffer;
  }
};

const sanitizeCutoutBufferForComposite = async (inputBuffer) => {
  if (!inputBuffer) {
    return inputBuffer;
  }

  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let changed = false;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha <= 20) {
      if (data[index] || data[index + 1] || data[index + 2] || alpha) {
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = 0;
        changed = true;
      }
      continue;
    }

    const alphaRatio = alpha / 255;
    const red = data[index];
    const green = data[index + 1];
    const blue = data[index + 2];
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const channelSpread = maxChannel - minChannel;

    if (alpha < 245) {
      data[index] = Math.min(255, Math.round(red / alphaRatio));
      data[index + 1] = Math.min(255, Math.round(green / alphaRatio));
      data[index + 2] = Math.min(255, Math.round(blue / alphaRatio));
      changed = true;
    }

    // Remove low-alpha neutral matte leftovers from imperfect AI cutouts.
    if (alpha < 110 && channelSpread < 18 && maxChannel < 210) {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
      changed = true;
    }
  }

  const sanitizedBuffer = changed
    ? await sharp(data, {
        raw: {
          width: info.width,
          height: info.height,
          channels: info.channels,
        },
      })
        .png()
        .toBuffer()
    : inputBuffer;

  return sharp(sanitizedBuffer)
    .ensureAlpha()
    .trim()
    .png()
    .toBuffer();
};

const stripCtaInstructionsFromPrompt = (promptText) => {
  let text = String(promptText || '');
  if (!text) {
    return '';
  }
  const cleanupPatterns = [
    /CTA text[^.]*EXACTLY\s*"[^"]*"\.*/gi,
    /Target CTA for final render:\s*"[^"]*"\.*/gi,
    /\bCTA(?:\s*for final render)?\s*:\s*[A-Za-z ]{2,80}\.?/gi,
    /Call to action(?: text)?\s*:\s*[A-Za-z ]{2,80}\.?/gi,
    /Add a CTA button[^.]*\./gi,
    /Add a\s+"[^"]{2,80}"\s+button\s+at\s+the\s+bottom\./gi,
    /and a\s+"[^"]{2,80}"\s+button\s+at\s+the\s+bottom\./gi,
    /button\s+at\s+the\s+bottom(?:\s+center)?\.?/gi,
    /Do not render any CTA text on the image\./gi,
    /No CTA text\./gi,
  ];
  for (const pattern of cleanupPatterns) {
    text = text.replace(pattern, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
};

const escapeSvgText = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const buildWizardPromptSummary = (draft) => {
  const hasBrandLogo = Boolean(String(draft?.brand_logo_file || '').trim());
  const lines = [
    `Product: ${draft?.product_focus || 'not set'}`,
    `Theme: ${draft?.main_theme || 'not set'}`,
    `Mood: ${draft?.visual_mood || 'not set'}`,
    `Dynamic: ${draft?.dynamic_elements || 'not set'}`,
    `Palette: ${draft?.color_palette || 'not set'}`,
    `Background: ${draft?.background_environment || 'not set'}`,
    `Brand Text Overlay: ${draft?.brand_name || 'none'}`,
    `Lighting: ${draft?.lighting || 'not set'}`,
    `Format: ${draft?.format || '1:1'}`,
    `CTA: ${draft?.cta || 'none'}`,
    `Logo: ${hasBrandLogo ? 'attached PNG' : 'none'}`,
  ];
  return lines.join('\n');
};

const normalizeTelegramLightingFocus = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return 'softbox';
  }
  if (raw.includes('softbox')) {
    return 'softbox';
  }
  if (raw.includes('cinematic')) {
    return 'cinematic';
  }
  if (raw.includes('natural')) {
    return 'natural';
  }
  if (raw.includes('studio')) {
    return 'studio';
  }
  return 'softbox';
};

const mapTelegramDraftToMainPromptFields = (draft = {}) => {
  const normalizedBrandOverlay = normalizeBrandOverlayText(draft.brand_name || '');
  const normalizedCta = normalizeCtaChoice(draft.cta, '');
  const hasLogoImage = Boolean(String(draft.brand_logo_file || '').trim());
  const useWebBrandTextPipeline = TELEGRAM_USE_WEB_BRAND_TEXT_PIPELINE;

  return {
    productName: String(draft.product_focus || '').trim(),
    mainIngredient: String(draft.main_theme || '').trim(),
    visualMood: String(draft.visual_mood || '').trim(),
    dynamicElements: String(draft.dynamic_elements || '').trim(),
    colorPalette: String(draft.color_palette || '').trim(),
    backgroundStyle: String(draft.background_environment || '').trim(),
    // Keep Telegram aligned with web prompt behavior by default.
    brandName: useWebBrandTextPipeline ? normalizedBrandOverlay : '',
    ctaText: normalizedCta,
    aspectRatio: String(draft.format || '').trim(),
    lightingFocus: normalizeTelegramLightingFocus(draft.lighting),
    extraNotes: String(draft.additional_directives || '').trim(),
    addQualityTags: true,
    hasLogoImage: useWebBrandTextPipeline
      ? hasLogoImage
      : (hasLogoImage || Boolean(normalizedBrandOverlay) || Boolean(normalizedCta)),
  };
};

const normalizeBrandOverlayText = (value) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  const lowered = text.toLowerCase();
  if (['none', 'skip', 'no', 'n/a', '-'].includes(lowered)) {
    return '';
  }
  return text.slice(0, 60);
};

const splitBrandOverlayLines = (text) => {
  const normalized = normalizeBrandOverlayText(text);
  if (!normalized) {
    return [];
  }
  const words = normalized.split(' ').filter(Boolean);
  if (words.length <= 1) {
    return [normalized];
  }
  const pivot = Math.ceil(words.length / 2);
  const lineOne = words.slice(0, pivot).join(' ').trim();
  const lineTwo = words.slice(pivot).join(' ').trim();
  return [lineOne, lineTwo].filter(Boolean).slice(0, 2);
};

const buildStrictProductPromptFromDraft = (draft) => {
  return buildMainPrompt(mapTelegramDraftToMainPromptFields(draft));
};

const processProductImage = async ({
  userId,
  projectId,
  referenceAssetId,
  productImageUrl,
  productImageDataUrl,
  referenceImageUrl = '',
  referenceImageDataUrl = '',
  logoImageDataUrl,
  brandTextOverlay,
  referenceMode,
  prompt,
  sendProgressUpdate = null,
}) => {
  const defaultPrompt =
    'Create a premium, high-converting product advertisement with cinematic lighting and clean brand composition.';
  const hasBackgroundReferenceInput = Boolean(
    String(referenceImageDataUrl || '').startsWith('data:') || String(referenceImageUrl || '').trim()
  );
  const promptRaw = String(prompt ?? '').trim();
  const finalPrompt = promptRaw ||
    (hasBackgroundReferenceInput ? '' : String(process.env.TELEGRAM_DEFAULT_PROMPT || defaultPrompt).trim());
  const provider =
    String(process.env.TELEGRAM_GENERATION_PROVIDER || 'openai').toLowerCase() === 'gemini'
      ? 'gemini'
      : 'openai';
  const normalizedBrandTextOverlay = TELEGRAM_USE_WEB_BRAND_TEXT_PIPELINE
    ? ''
    : String(brandTextOverlay || '');
  const modelName =
    provider === 'openai'
      ? (process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1')
      : (process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image');
  const hasBackgroundReference = hasBackgroundReferenceInput;
  const runReferenceMode = String(
    referenceMode || (hasBackgroundReference ? 'auto' : (provider === 'openai' ? 'openai' : 'edit'))
  ).toLowerCase();
  let runId = null;

  try {
    const requestResult = await pool.query(
      `
        INSERT INTO generation_requests (
          project_id, created_by_user_id, reference_asset_id, final_prompt
        )
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [projectId, userId, referenceAssetId, finalPrompt]
    );
    const generationRequestId = requestResult.rows[0].id;

    const runResult = await pool.query(
      `
        INSERT INTO generation_runs (
          request_id, provider, model_name, reference_mode, status, started_at, caption_type
        )
        VALUES ($1, $2, $3, $4, 'running', NOW(), 'caption')
        RETURNING id
      `,
      [generationRequestId, provider, modelName, runReferenceMode]
    );
    runId = runResult.rows[0].id;

    const productDataUrl = productImageDataUrl || await fetchRemoteImageAsDataUrl(productImageUrl);
    let referenceDataUrl = '';
    if (referenceImageDataUrl) {
      referenceDataUrl = referenceImageDataUrl;
    } else if (referenceImageUrl) {
      referenceDataUrl = await fetchRemoteImageAsDataUrl(referenceImageUrl);
    }
    const internalGenerateMode = String(process.env.TELEGRAM_INTERNAL_GENERATE_MODE || 'local_first').toLowerCase();
    const shouldTryLocalFirst = internalGenerateMode !== 'http_only';
    const shouldAllowHttpFallback = internalGenerateMode !== 'local_only';
    const internalGenerateTimeoutMs = Number.isFinite(Number(process.env.INTERNAL_GENERATE_TIMEOUT_MS))
      ? Math.max(5000, Math.floor(Number(process.env.INTERNAL_GENERATE_TIMEOUT_MS)))
      : 90000;
    const apiBaseCandidates = Array.from(new Set([
      String(process.env.INTERNAL_API_BASE_URL || '').trim(),
      String(process.env.PUBLIC_SERVER_URL || '').trim(),
    ]
      .map((value) => value.replace(/\/$/, ''))
      .filter(Boolean)));
    const externalApiBaseCandidates = Array.from(new Set([
      String(process.env.TELEGRAM_EXTERNAL_API_BASE_URL || '').trim(),
      ...apiBaseCandidates,
    ]
      .map((value) => value.replace(/\/$/, ''))
      .filter(Boolean)));
    const telegramProjectApiKey = String(
      process.env.TELEGRAM_PROJECT_API_KEY ||
      process.env.TELEGRAM_EXTERNAL_PROJECT_API_KEY ||
      ''
    ).trim();
    const telegramProjectApiMode = String(process.env.TELEGRAM_PROJECT_API_MODE || 'external_only').trim().toLowerCase();
    const useTelegramProjectExternalApi =
      telegramProjectApiMode !== 'off' &&
      Boolean(telegramProjectApiKey) &&
      hasBackgroundReference &&
      externalApiBaseCandidates.length > 0;
    const strictTelegramProjectExternalApi =
      String(process.env.TELEGRAM_PROJECT_API_STRICT || 'true').toLowerCase() !== 'false';

    let generatePayload = null;
    let lastGenerateError = null;

    if (useTelegramProjectExternalApi) {
      for (let index = 0; index < externalApiBaseCandidates.length; index += 1) {
        const apiBaseUrl = externalApiBaseCandidates[index];
        const isLastCandidate = index === externalApiBaseCandidates.length - 1;
        try {
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), internalGenerateTimeoutMs);
          let generateResponse = null;
          try {
            generateResponse = await fetch(`${apiBaseUrl}${PROJECT_API_EXTERNAL_GENERATE_PATH}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-project-api-key': telegramProjectApiKey,
              },
              body: JSON.stringify({
                prompt: finalPrompt,
                productImage: productDataUrl,
                referenceImage: referenceDataUrl || '',
                referenceMode: runReferenceMode,
                pipelineName: hasBackgroundReference ? PIPELINE_NAME_GEMINI_REFERENCE_GUIDED : undefined,
                logoImage: logoImageDataUrl || '',
                brandTextOverlay: normalizedBrandTextOverlay,
                source: 'telegram_bot',
                skipCaptionGeneration: true,
              }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutHandle);
          }

          const parsedPayload = await generateResponse.json().catch(() => ({}));
          if (generateResponse.ok) {
            generatePayload = parsedPayload;
            break;
          }

          const details = parsedPayload?.details || parsedPayload?.error || `External generation request failed (${generateResponse.status})`;
          throw new Error(details);
        } catch (error) {
          lastGenerateError = error;
          if (!isLastCandidate) {
            console.warn(
              `[processProductImage] External project API request via ${apiBaseUrl} failed: ${error.message}. Trying next base URL...`
            );
            continue;
          }
        }
      }

      if (!generatePayload && strictTelegramProjectExternalApi) {
        throw new Error(lastGenerateError?.message || 'External project API generation request failed');
      }
    }

    if (!generatePayload && shouldTryLocalFirst) {
      const localGenerateResult = await invokeGenerateApiLocally({
        prompt: finalPrompt,
        productImage: productDataUrl,
        referenceImage: referenceDataUrl || '',
        referenceMode: runReferenceMode,
        logoImage: logoImageDataUrl || '',
        brandTextOverlay: normalizedBrandTextOverlay,
        source: 'telegram_bot',
        skipCaptionGeneration: true,
        onProgress: typeof sendProgressUpdate === 'function'
          ? async (step, message) => sendProgressUpdate(step, message)
          : null,
      });
      if (localGenerateResult.ok) {
        generatePayload = localGenerateResult.payload || {};
      } else {
        const localPayloadPreview = (() => {
          try {
            const text = JSON.stringify(localGenerateResult.payload || {});
            return text.length > 800 ? `${text.slice(0, 800)}...` : text;
          } catch (error) {
            return '';
          }
        })();
        const details =
          localGenerateResult.payload?.details ||
          localGenerateResult.payload?.error ||
          localPayloadPreview ||
          `Local generation request failed (${localGenerateResult.status})`;
        lastGenerateError = new Error(details);
        console.warn('[processProductImage] Internal generate handler failed. Will try HTTP fallback if configured.', details);
      }
    }

    if (!generatePayload && shouldAllowHttpFallback) {
      if (!apiBaseCandidates.length) {
        console.warn('[processProductImage] No HTTP API base candidate configured for fallback.');
      }
      for (let index = 0; index < apiBaseCandidates.length; index += 1) {
        const apiBaseUrl = apiBaseCandidates[index];
        const isLastCandidate = index === apiBaseCandidates.length - 1;
        try {
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), internalGenerateTimeoutMs);
          let generateResponse = null;
          try {
            generateResponse = await fetch(`${apiBaseUrl}/api/generate`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-internal-api-key': INTERNAL_API_KEY,
              },
              body: JSON.stringify({
                prompt: finalPrompt,
                productImage: productDataUrl,
                referenceImage: referenceDataUrl || '',
                referenceMode: runReferenceMode,
                logoImage: logoImageDataUrl || '',
                brandTextOverlay: normalizedBrandTextOverlay,
                source: 'telegram_bot',
              skipCaptionGeneration: true,
            }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutHandle);
          }

          const parsedPayload = await generateResponse.json().catch(() => ({}));
          if (generateResponse.ok) {
            generatePayload = parsedPayload;
            break;
          }

          if (generateResponse.status === 404 && !isLastCandidate) {
            console.warn(`[processProductImage] /api/generate returned 404 at ${apiBaseUrl}. Trying next base URL...`);
            continue;
          }

          console.error(
            '[processProductImage] /api/generate failed',
            { baseUrl: apiBaseUrl, status: generateResponse.status, payload: parsedPayload }
          );
          const details = parsedPayload?.details || parsedPayload?.error || `Generation request failed (${generateResponse.status})`;
          throw new Error(details);
        } catch (error) {
          lastGenerateError = error;
          if (!isLastCandidate) {
            console.warn(`[processProductImage] Request via ${apiBaseUrl} failed: ${error.message}. Trying next base URL...`);
            continue;
          }
        }
      }
    }

    if (!generatePayload) {
      throw new Error(lastGenerateError?.message || 'Generation request failed');
    }

    const generatedImageUrl = generatePayload?.imageUrl || '';
    if (!generatedImageUrl) {
      throw new Error('No image returned from generation pipeline');
    }

    const mimeType = generatedImageUrl.startsWith('data:') && generatedImageUrl.includes(';')
      ? generatedImageUrl.slice(5, generatedImageUrl.indexOf(';'))
      : 'image/png';

    const generatedAssetResult = await pool.query(
      `
        INSERT INTO assets (
          project_id,
          uploaded_by_user_id,
          asset_type,
          storage_provider,
          storage_key,
          public_url,
          mime_type,
          metadata
        )
        VALUES ($1, $2, 'generated_image', 'local', $3, $4, $5, $6::jsonb)
        RETURNING id
      `,
      [
        projectId,
        userId,
        `generated/${runId}/variant-1-${Date.now()}.png`,
        generatedImageUrl,
        mimeType,
        JSON.stringify({ source: 'telegram_bot', run_id: runId }),
      ]
    );
    const outputAssetId = generatedAssetResult.rows[0].id;

    await pool.query(
      `
        INSERT INTO generation_outputs (
          run_id, variant_no, caption, image_asset_id
        )
        VALUES ($1, 1, $2, $3)
      `,
      [runId, generatePayload?.caption || '', outputAssetId]
    );

    await pool.query(
      `
        UPDATE generation_runs
        SET status = 'succeeded',
            generated_caption = $1,
            background_prompt = $2,
            edit_instruction = $3,
            raw_response = $4::jsonb,
            finished_at = NOW()
        WHERE id = $5
      `,
      [
        generatePayload?.caption || '',
        generatePayload?.backgroundPrompt || null,
        generatePayload?.editInstruction || null,
        JSON.stringify({
          captionType: generatePayload?.captionType || 'caption',
          usedReferenceImage: Boolean(generatePayload?.usedReferenceImage),
          referenceMode: generatePayload?.referenceMode || 'none',
          pipelineName: generatePayload?.pipelineName || '',
          generationFlow: generatePayload?.generationFlow || '',
        }),
        runId,
      ]
    );

    return {
      runId,
      generationRequestId,
      outputAssetId,
      imageUrl: generatedImageUrl,
      caption: generatePayload?.caption || '',
    };
  } catch (error) {
    if (runId) {
      await pool.query(
        `
          UPDATE generation_runs
          SET status = 'failed',
              error_text = $1,
              finished_at = NOW()
          WHERE id = $2
        `,
        [error.message || 'Processing failed', runId]
      );
    }
    throw error;
  }
};

const setupTelegramBot = () => {
  const botToken = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn('Telegram bot disabled: BOT_TOKEN/TELEGRAM_BOT_TOKEN missing');
    return null;
  }

  const bot = new Telegraf(botToken);
  const TELEGRAM_MENU_LABELS = {
    start: '\u{1F680} Start',
    signin: '\u{1F510} Sign In',
    shareContact: '\u{1F4F1} Share Contact',
    fillAi: '\u{2728} Fill Up with AI',
    new: '\u{1F9ED} New Wizard',
    generate: '\u{1F3A8} Generate',
    credits: '\u{1F4B3} Credits',
    buy: '\u{1F4B0} Buy Credits',
    help: '\u{2753} Help',
    logout: '\u{1F50C} Logout',
    cancel: '\u{1F6D1} Cancel Wizard',
    menu: '\u{1F4CB} Menu',
    simpleMode: '\u{26A1} Simple',
    advanceMode: '\u{1F6E0}\u{FE0F} Advance',
    regenerate: '\u{1F504} Regenerate',
    yesReference: '\u{2705} Yes, Add Reference',
    noReference: '\u{274C} No, Continue',
  };

  const buildTelegramMainMenuKeyboard = (user = null) => {
    const hasLinkedUser = Boolean(user?.id);
    const botState = normalizeBotState(user?.bot_state);
    const hasCompletedSignIn = hasLinkedUser && !isRegistrationPendingState(botState);
    if (!hasCompletedSignIn) {
      return Markup.keyboard([
        [TELEGRAM_MENU_LABELS.start],
        [TELEGRAM_MENU_LABELS.signin],
        [TELEGRAM_MENU_LABELS.help],
      ]).resize();
    }
    return Markup.keyboard([
      [TELEGRAM_MENU_LABELS.start],
      [TELEGRAM_MENU_LABELS.credits, TELEGRAM_MENU_LABELS.buy],
      [TELEGRAM_MENU_LABELS.help, TELEGRAM_MENU_LABELS.logout],
    ]).resize();
  };
  const buildTelegramMainMenuKeyboardForCtx = (ctx, userOverride = null) =>
    buildTelegramMainMenuKeyboard(userOverride || ctx?.state?.dbUser || null);

  const buildTelegramPhoneRequestKeyboard = (user = null) => {
    const hasLinkedUser = Boolean(user?.id);
    const botState = normalizeBotState(user?.bot_state);
    const hasCompletedSignIn = hasLinkedUser && !isRegistrationPendingState(botState);
    const rows = [[Markup.button.contactRequest(TELEGRAM_MENU_LABELS.shareContact)]];
    if (hasCompletedSignIn) {
      rows.push([TELEGRAM_MENU_LABELS.start]);
      rows.push([TELEGRAM_MENU_LABELS.help, TELEGRAM_MENU_LABELS.logout]);
    } else {
      rows.push([TELEGRAM_MENU_LABELS.start]);
      rows.push([TELEGRAM_MENU_LABELS.signin], [TELEGRAM_MENU_LABELS.help]);
    }
    return Markup.keyboard(rows).resize();
  };

  const buildWizardModeSelectionKeyboard = () =>
    Markup.keyboard([
      [TELEGRAM_MENU_LABELS.simpleMode, TELEGRAM_MENU_LABELS.advanceMode],
      [TELEGRAM_MENU_LABELS.cancel],
    ]).resize();
  const buildWizardCancelOnlyKeyboard = () =>
    Markup.keyboard([[TELEGRAM_MENU_LABELS.cancel]]).resize();
  const buildSimpleReferenceDecisionKeyboard = () =>
    Markup.keyboard([
      [TELEGRAM_MENU_LABELS.yesReference, TELEGRAM_MENU_LABELS.noReference],
      [TELEGRAM_MENU_LABELS.cancel],
    ]).resize();
  const buildTelegramPostGenerationKeyboard = () =>
    Markup.keyboard([
      [TELEGRAM_MENU_LABELS.regenerate, TELEGRAM_MENU_LABELS.new],
      [TELEGRAM_MENU_LABELS.cancel],
    ]).resize();
  const buildTelegramUsageProgressBar = (usedPercent = 0, segments = 12) => {
    const safeSegments = Math.max(6, Math.min(24, Math.floor(Number(segments) || 12)));
    const pct = Math.max(0, Math.min(100, Math.round(Number(usedPercent) || 0)));
    const filled = Math.round((pct / 100) * safeSegments);
    return `[${'\u2588'.repeat(filled)}${'\u2591'.repeat(Math.max(0, safeSegments - filled))}]`;
  };

  const sendEmailPrompt = async (ctx) =>
    ctx.reply(
      [
        '\u{1F4E7} Sign-In Required',
        'Please share your email address to continue.',
      ].join('\n'),
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );

  const sendEmailVerificationPrompt = async (ctx, email = '') =>
    ctx.reply(
      [
        '\u{1F4EC} Verification Required',
        `We've sent a ${EMAIL_VERIFICATION_CODE_LENGTH}-digit code to:`,
        `${maskEmailAddress(email) || 'your email'}`,
        '',
        'Reply with the code to continue.',
        'Didn\'t receive it? Type: resend',
      ].join('\n'),
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );

  const sendPhonePrompt = async (ctx) =>
    ctx.reply(
      [
        '\u{2705} Email Verified',
        '\u{1F4F1} Next Step: Tap "Share Contact" to securely link your Telegram phone number.',
      ].join('\n'),
      buildTelegramPhoneRequestKeyboard(ctx?.state?.dbUser || null)
    );

  const TELEGRAM_PLAN_FREE_CALLBACK_DATA = 'tg_plan_free';
  const buildTelegramPlanButtonLabel = (plan) => {
    const name = String(plan?.name || '').trim() || String(plan?.tier || '').toUpperCase();
    const priceUsdMonthly = Number(plan?.priceUsdMonthly || 0);
    if (priceUsdMonthly <= 0) {
      return `\u{1F193} ${name} (Free)`;
    }
    return `\u{1F539} ${name} ($${priceUsdMonthly.toFixed(2)}/mo)`;
  };

  const activateTelegramFreePlan = async (userId) => {
    const freePlan = getPlanConfig('free');
    const updatedResult = await pool.query(
      `
        UPDATE users
        SET plan_tier = 'free',
            plan_status = 'active',
            daily_credit_quota = $2,
            credits = GREATEST(COALESCE(credits, 0), $2),
            bot_state = $3,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [userId, freePlan.monthlyCredits, BOT_STATE_IDLE]
    );
    return updatedResult.rows[0] || null;
  };

  const sendPlanSelectionPrompt = async (ctx, user, title = '\u{2705} Registration Complete') => {
    const telegramId = toTelegramId(ctx) || String(user?.telegram_id || '').trim();
    if (!telegramId || !user?.id) {
      await sendAccountReadyMessage(ctx, user, title);
      return;
    }

    let latestUser = user;
    if (normalizeBotState(user.bot_state) !== BOT_STATE_AWAITING_PLAN_SELECTION) {
      const updatedResult = await pool.query(
        `
          UPDATE users
          SET bot_state = $2,
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
        `,
        [user.id, BOT_STATE_AWAITING_PLAN_SELECTION]
      );
      latestUser = updatedResult.rows[0] || user;
    }

    const allPlans = getOrderedPlanConfigs();
    const freePlan = getPlanConfig('free');
    const paidPlans = allPlans.filter((plan) => plan.tier !== 'free');
    const buttonRows = [
      [Markup.button.callback(`\u{1F193} ${freePlan.name} (Instant)`, TELEGRAM_PLAN_FREE_CALLBACK_DATA)],
    ];

    for (const plan of paidPlans) {
      let checkoutUrl = '';
      try {
        checkoutUrl = await createTelegramPlanCheckoutUrl({
          telegramId,
          user: latestUser,
          planTier: plan.tier,
        });
      } catch (error) {
        console.warn(`Telegram plan checkout creation failed for ${plan.tier}:`, error.message);
      }
      if (!checkoutUrl) {
        continue;
      }
      buttonRows.push([Markup.button.url(buildTelegramPlanButtonLabel(plan), checkoutUrl)]);
    }

    const planLines = allPlans.map((plan) => {
      const price = Number(plan.priceUsdMonthly || 0);
      const credits = Math.floor(Number(plan.monthlyCredits || 0));
      const priceText = price <= 0 ? 'Free' : `$${price.toFixed(2)}/month`;
      return `- ${plan.name}: ${priceText}, ${credits} credits`;
    });

    const messageLines = [
      title,
      '\u{1F4E6} Choose your plan:',
      ...planLines,
      '',
      '\u{1F193} Free plan activates instantly.',
      '\u{1F4B3} Paid plans continue in Stripe checkout.',
    ];
    if (buttonRows.length <= 1) {
      messageLines.push('', 'Stripe checkout is currently unavailable. You can continue with the Free plan.');
    }

    await ctx.reply(
      messageLines.join('\n'),
      Markup.inlineKeyboard(buttonRows)
    );
  };

  const sendPostRegistrationPlanPromptOrReady = async (ctx, user, title = '\u{2705} Registration Complete') => {
    if (!user) {
      return;
    }
    if (isUsageLimitExemptUser(user) || normalizePlanTier(user.plan_tier) !== 'free') {
      await sendAccountReadyMessage(ctx, user, title);
      return;
    }
    await sendPlanSelectionPrompt(ctx, user, title);
  };

  const sendAccountReadyMessage = async (ctx, user, title = '\u{2705} Login Successful!') =>
    ctx.reply(
      [
        `${title}`,
        `\u{1F44B} Welcome back, ${user?.username || 'there'}.`,
        `\u{1F4B0} Current Credits: ${Number(user?.credits || 0)}`,
        '\u{1F5C2}\u{FE0F} Next Step: Send your background-removed PNG as a Document/File (recommended) to start processing.',
      ].join('\n'),
      buildTelegramMainMenuKeyboardForCtx(ctx, user || null)
    );

  const TELEGRAM_WELCOME_IMAGE_PATH_CANDIDATES = [
    path.resolve(__dirname, 'assets', 'telegram', 'adready_telegram_start_image.jpeg'),
    path.resolve(__dirname, 'assets', 'telegram', 'branding_img.png'),
    path.resolve(__dirname, 'assets', 'telegram', 'branding_img.jpg'),
    path.resolve(__dirname, 'assets', 'telegram', 'branding_img.jpeg'),
    path.resolve(__dirname, 'assets', 'telegram', 'branding_img.webp'),
  ];
  const TELEGRAM_WELCOME_IMAGE_PATH = TELEGRAM_WELCOME_IMAGE_PATH_CANDIDATES.find((filePath) => {
    try {
      return fs.existsSync(filePath);
    } catch (error) {
      return false;
    }
  }) || '';

  const isTelegramStartIntroTrigger = (ctx) => {
    const text = String(ctx?.message?.text || '').trim();
    if (!text) {
      return false;
    }
    return (
      /^\/(?:start|new)(?:\s|$)/i.test(text) ||
      text === TELEGRAM_MENU_LABELS.start ||
      text === TELEGRAM_MENU_LABELS.new
    );
  };

  const sendTelegramWelcomeIntro = async (ctx) => {
    const caption = [
      '\u{1F451} Royal Bengal AI \u2022 AdReady',
      '',
      'Create premium ad creatives from your product PNG in minutes.',
      '',
      'How it works:',
      '1) Sign in with your email',
      '2) Upload a bg-removed PNG as Document/File (recommended)',
      '3) Choose Simple (auto) or Advance (guided wizard)',
    ].join('\n');
    if (TELEGRAM_WELCOME_IMAGE_PATH) {
      await ctx.replyWithPhoto(
        { source: TELEGRAM_WELCOME_IMAGE_PATH },
        { caption }
      );
      return;
    }
    await ctx.reply(caption);
  };

  bot.use(async (ctx, next) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return next();
    }
    const result = await pool.query(
      `
        SELECT *
        FROM users
        WHERE telegram_id = $1::bigint
        LIMIT 1
      `,
      [telegramId]
    );
    ctx.state.dbUser = result.rows[0] || null;
    ctx.state.botState = ctx.state.dbUser?.bot_state || 'IDLE';
    return next();
  });

  const handleTelegramSignIn = async (ctx) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return;
    }

    if (isTelegramStartIntroTrigger(ctx)) {
      try {
        await sendTelegramWelcomeIntro(ctx);
      } catch (error) {
        console.warn('Failed to send Telegram welcome intro:', error.message);
      }
    }

    const existingUser = ctx.state.dbUser;
    if (existingUser) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updatedResult = await client.query(
          `
            UPDATE users
            SET bot_state = $2,
                is_active = TRUE,
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `,
          [
            existingUser.id,
            getRegistrationStateForUser(existingUser),
          ]
        );
        const refreshedUser = updatedResult.rows[0];
        await createTelegramSessionTx(client, refreshedUser.id, telegramId);
        await client.query('COMMIT');

        scheduleTelegramProfileSync(refreshedUser.id, telegramId, ctx.from);

        const refreshedState = normalizeBotState(refreshedUser.bot_state);
        if (refreshedState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
          await sendEmailPrompt(ctx);
          return;
        }
        if (refreshedState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
          const verificationRecord = getEmailVerificationRecord(refreshedUser);
          await sendEmailVerificationPrompt(ctx, verificationRecord?.pendingEmail || refreshedUser.email || '');
          return;
        }
        if (refreshedState === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
          await sendPhonePrompt(ctx);
          return;
        }
        if (refreshedState === BOT_STATE_AWAITING_PLAN_SELECTION) {
          await sendPlanSelectionPrompt(ctx, refreshedUser, '\u{2705} Registration Complete');
          return;
        }

        await sendAccountReadyMessage(ctx, refreshedUser, '\u{2705} Login Successful!');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      return;
    }

    const startPayloadEmail = extractStartPayloadEmail(ctx);
    if (startPayloadEmail) {
      const existingByEmail = await pool.query(
        `
          SELECT *
          FROM users
          WHERE LOWER(email) = LOWER($1)
          LIMIT 1
        `,
        [startPayloadEmail]
      );

      if (existingByEmail.rowCount) {
        const matchedUser = existingByEmail.rows[0];
        if (matchedUser.telegram_id && String(matchedUser.telegram_id) !== telegramId) {
          await ctx.reply('This email is already linked to another Telegram account.');
          return;
        }
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const username = await findAvailableUsername(
        client,
        buildTelegramUsernameCandidates(ctx, telegramId),
        `tg_${telegramId}`
      );
      const createdUserResult = await client.query(
        `
          INSERT INTO users (
            username, password_hash, telegram_id, bot_state, credits, bot_data, role, is_active, created_at, updated_at
          )
          VALUES ($1, NULL, $2::bigint, $3, 5, '{"onboarding":"email","email_verification_required":true}'::jsonb, 'member', TRUE, NOW(), NOW())
          RETURNING *
        `,
        [username, telegramId, BOT_STATE_AWAITING_REGISTRATION_EMAIL]
      );
      const createdUser = createdUserResult.rows[0];
      await createTelegramSessionTx(client, createdUser.id, telegramId);
      await client.query('COMMIT');

      scheduleTelegramProfileSync(createdUser.id, telegramId, ctx.from);
    } catch (error) {
      await client.query('ROLLBACK');
      if (error?.code !== '23505') {
        throw error;
      }
    } finally {
      client.release();
    }

    if (startPayloadEmail) {
      await ctx.reply(
        `\u{1F510} Sign-In Verification\nPlease confirm your email to continue.\nEmail hint: ${maskEmailAddress(startPayloadEmail)}`,
        buildTelegramMainMenuKeyboardForCtx(ctx)
      );
      return;
    }

    await sendEmailPrompt(ctx);
  };

  bot.start(handleTelegramSignIn);
  bot.command('signin', handleTelegramSignIn);

  const getUserBotData = (user) => {
    if (!user?.bot_data || typeof user.bot_data !== 'object') {
      return {};
    }
    return user.bot_data;
  };

  const getUserDraft = (user) => {
    const botData = getUserBotData(user);
    if (!botData.generation_draft || typeof botData.generation_draft !== 'object') {
      return {};
    }
    return botData.generation_draft;
  };

  const getDraftAiSuggestions = (draft) =>
    draft?.ai_suggestions && typeof draft.ai_suggestions === 'object'
      ? draft.ai_suggestions
      : {};

  const getDraftAiOptionSuggestions = (draft) =>
    draft?.ai_option_suggestions && typeof draft.ai_option_suggestions === 'object'
      ? draft.ai_option_suggestions
      : {};

  const getAiSuggestionForStep = (draft, stepKey) => {
    const suggestions = getDraftAiSuggestions(draft);
    const value = String(suggestions?.[stepKey] || '').trim();
    return value.slice(0, 220);
  };

  const normalizeAiSuggestionValue = (value) =>
    String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);

  const normalizeAiOptionList = (value) => {
    const values = Array.isArray(value)
      ? value
      : String(value || '').split(/\s*\|\s*|\s*;\s*|\s*\/\s*|\s*,\s*/g);
    const unique = [];
    const seen = new Set();
    for (const itemRaw of values) {
      const item = normalizeAiSuggestionValue(itemRaw);
      const key = item.toLowerCase();
      if (!item || item.length < 2 || seen.has(key)) {
        continue;
      }
      seen.add(key);
      unique.push(item);
      if (unique.length >= 4) {
        break;
      }
    }
    return unique;
  };

  const getTelegramWizardAnalyzeProvider = () =>
    String(process.env.TELEGRAM_FILL_ANALYZE_PROVIDER || 'gemini').trim().toLowerCase() === 'openai'
      ? 'openai'
      : 'gemini';

  const buildAutoAdditionalDirective = (source = {}) => {
    const product = normalizeAiSuggestionValue(
      source?.product_focus || source?.productName || 'the product'
    );
    const theme = normalizeAiSuggestionValue(source?.main_theme || source?.mainIngredient || '');
    const mood = normalizeAiSuggestionValue(source?.visual_mood || source?.visualMood || 'premium');
    const dynamic = normalizeAiSuggestionValue(source?.dynamic_elements || source?.dynamicElements || 'subtle motion');
    const palette = normalizeAiSuggestionValue(source?.color_palette || source?.colorPalette || '');
    const background = normalizeAiSuggestionValue(source?.background_environment || source?.backgroundStyle || '');

    const parts = [
      `Highlight ${product} with ${dynamic.toLowerCase()}.`,
      `Keep the mood ${mood.toLowerCase()} and composition clean.`,
    ];
    if (theme) {
      parts.push(`Use ${theme.toLowerCase()} as the hero theme.`);
    }
    if (palette) {
      parts.push(`Match a ${palette.toLowerCase()} color balance.`);
    }
    if (background) {
      parts.push(`Keep background style ${background.toLowerCase()}.`);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 220);
  };

  const buildFallbackAiOptionsForStep = (stepKey, seedValue) => {
    const seed = normalizeAiSuggestionValue(seedValue);
    if (!seed) {
      return [];
    }
    const ctaSeed = normalizeCtaChoice(seed, 'Shop Now');
    const ctaFallbacks = [ctaSeed, ...ALLOWED_CTA_VALUES.filter((item) => item !== ctaSeed)].slice(0, 4);
    const defaultsByStep = {
      product_focus: [`${seed}`, `${seed} Pro`, `${seed} Premium`],
      main_theme: [`${seed}`, `${seed} close-up`, `${seed} hero composition`],
      visual_mood: [`${seed}`, `${seed} cinematic`, `${seed} premium`],
      dynamic_elements: [`${seed}`, `${seed} motion`, `${seed} energetic flow`],
      color_palette: [`${seed}`, `${seed} contrast`, `${seed} balanced tones`],
      background_environment: [`${seed}`, `${seed} studio`, `${seed} abstract backdrop`],
      brand_name: [`${seed}`, `${seed} Noir`, `${seed} Signature`],
      lighting: [`${seed}`, `${seed} with rim light`, `${seed} with soft highlights`],
      format: [`${seed}`, '1:1', '4:5'],
      cta: ctaFallbacks,
      additional_directives: [`${seed}`, `${seed}, keep premium look`, `${seed}, clean composition`],
    };
    if (stepKey === 'cta') {
      return normalizeCtaOptionList(defaultsByStep.cta || ctaFallbacks);
    }
    return normalizeAiOptionList(defaultsByStep[stepKey] || [seed]);
  };

  const isTelegramAdvanceFastFillEnabled = () =>
    String(process.env.TELEGRAM_ADVANCE_FAST_FILL || 'true').toLowerCase() !== 'false';

  const TELEGRAM_AI_FILL_LOCK_MS = Number.isFinite(Number(process.env.TELEGRAM_AI_FILL_LOCK_MS))
    ? Math.max(15000, Math.floor(Number(process.env.TELEGRAM_AI_FILL_LOCK_MS)))
    : 120000;

  const isTelegramAiFillInProgress = (draft = {}) => {
    if (String(draft?.ai_fill_status || '').trim().toLowerCase() !== 'running') {
      return false;
    }
    const startedAtRaw = String(draft?.ai_fill_started_at || '').trim();
    const startedAtMs = Date.parse(startedAtRaw);
    if (!Number.isFinite(startedAtMs)) {
      return true;
    }
    return (Date.now() - startedAtMs) < TELEGRAM_AI_FILL_LOCK_MS;
  };

  const applyTelegramAiFillState = (draft = {}, status = 'idle', errorText = '') => ({
    ...draft,
    ai_fill_status: String(status || 'idle').trim().toLowerCase(),
    ai_fill_started_at:
      String(status || '').trim().toLowerCase() === 'running'
        ? new Date().toISOString()
        : String(draft?.ai_fill_started_at || ''),
    ai_fill_completed_at:
      String(status || '').trim().toLowerCase() === 'running'
        ? ''
        : new Date().toISOString(),
    ai_fill_error: errorText ? String(errorText).slice(0, 320) : '',
    updated_at: new Date().toISOString(),
  });

  const buildFallbackWizardAiOptionSuggestions = (aiSuggestions = {}) => {
    const stepKeys = TELEGRAM_WIZARD_STEPS
      .map((step) => step.key)
      .filter((key) => key !== 'brand_logo_file');
    const globalFallbackSeed =
      normalizeAiSuggestionValue(aiSuggestions?.product_focus) ||
      normalizeAiSuggestionValue(aiSuggestions?.main_theme) ||
      normalizeAiSuggestionValue(aiSuggestions?.visual_mood) ||
      'Premium';
    const fallbackOptions = {};
    for (const key of stepKeys) {
      const seed = normalizeAiSuggestionValue(aiSuggestions?.[key]) || globalFallbackSeed;
      fallbackOptions[key] = buildFallbackAiOptionsForStep(key, seed);
    }
    return fallbackOptions;
  };

  const mergePrimarySuggestionIntoOptions = (stepKey, primarySuggestionRaw, optionValuesRaw) => {
    if (stepKey === 'cta') {
      const primary = normalizeCtaChoice(primarySuggestionRaw, '');
      const options = normalizeCtaOptionList(optionValuesRaw);
      const merged = [];
      const seen = new Set();
      if (primary && primary !== 'None') {
        const key = primary.toLowerCase();
        seen.add(key);
        merged.push(primary);
      }
      for (const option of options) {
        const key = String(option || '').toLowerCase();
        if (!option || option === 'None' || seen.has(key)) {
          continue;
        }
        seen.add(key);
        merged.push(option);
        if (merged.length >= 4) {
          break;
        }
      }
      return merged;
    }

    const primary = normalizeAiSuggestionValue(primarySuggestionRaw);
    const options = normalizeAiOptionList(optionValuesRaw);
    const merged = [];
    const seen = new Set();
    if (primary) {
      const key = primary.toLowerCase();
      seen.add(key);
      merged.push(primary);
    }
    for (const option of options) {
      const key = String(option || '').toLowerCase();
      if (!option || seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(option);
      if (merged.length >= 4) {
        break;
      }
    }
    return merged;
  };

  const getAiOptionCandidatesForStep = (draft, stepKey) => {
    if (stepKey === 'brand_logo_file' || stepKey === 'additional_directives') {
      return [];
    }
    const primarySuggestion = getAiSuggestionForStep(draft, stepKey);
    const aiOptionSuggestions = getDraftAiOptionSuggestions(draft);
    if (stepKey === 'cta') {
      const explicitCtaOptions = normalizeCtaOptionList(aiOptionSuggestions?.[stepKey]);
      if (explicitCtaOptions.length) {
        return mergePrimarySuggestionIntoOptions(stepKey, primarySuggestion, explicitCtaOptions);
      }
      const ctaFromSingleSuggestion = normalizeCtaOptionList(primarySuggestion);
      if (ctaFromSingleSuggestion.length) {
        return mergePrimarySuggestionIntoOptions(stepKey, primarySuggestion, ctaFromSingleSuggestion);
      }
      return mergePrimarySuggestionIntoOptions(stepKey, primarySuggestion, ['Shop Now', 'Buy Now', 'Learn More']);
    }
    const explicitOptions = normalizeAiOptionList(aiOptionSuggestions?.[stepKey]);
    if (explicitOptions.length) {
      return mergePrimarySuggestionIntoOptions(stepKey, primarySuggestion, explicitOptions);
    }

    const suggestion = normalizeAiSuggestionValue(primarySuggestion);
    const fallbackSeed =
      suggestion ||
      normalizeAiSuggestionValue(getAiSuggestionForStep(draft, 'product_focus')) ||
      normalizeAiSuggestionValue(getAiSuggestionForStep(draft, 'main_theme')) ||
      normalizeAiSuggestionValue(getAiSuggestionForStep(draft, 'visual_mood')) ||
      'Premium';
    if (!suggestion) {
      return mergePrimarySuggestionIntoOptions(
        stepKey,
        primarySuggestion,
        buildFallbackAiOptionsForStep(stepKey, fallbackSeed)
      );
    }
    const chunked = normalizeAiOptionList(suggestion);
    if (chunked.length >= 2) {
      return mergePrimarySuggestionIntoOptions(stepKey, primarySuggestion, chunked);
    }
    return mergePrimarySuggestionIntoOptions(
      stepKey,
      primarySuggestion,
      buildFallbackAiOptionsForStep(stepKey, fallbackSeed)
    );
  };

  const mapAnalyzeResultToWizardSuggestions = (analyzed) => {
    const suggestedFormat = String(analyzed?.aspectRatio || '').trim();
    const format = ['1:1', '4:5', '9:16', '16:9'].includes(suggestedFormat)
      ? suggestedFormat
      : '';
    const lightingRaw = String(analyzed?.lightingFocus || '').trim().toLowerCase();
    const lightingMap = {
      softbox: 'Softbox',
      cinematic: 'Cinematic',
      studio: 'Studio clean',
      natural: 'Studio clean',
    };
    const ctaRaw = String(analyzed?.ctaText || '').trim();
    const normalizedCta = normalizeCtaChoice(ctaRaw, 'Shop Now');
    const productFocusFallback = normalizeAiSuggestionValue(
      analyzed?.productName || analyzed?.mainIngredient || analyzed?.brandName || analyzed?.dynamicElements || ''
    );
    const mainThemeFallback = normalizeAiSuggestionValue(
      analyzed?.mainIngredient || analyzed?.productName || analyzed?.brandName || ''
    );
    const additionalDirectives = normalizeAiSuggestionValue(analyzed?.extraNotes || '') ||
      buildAutoAdditionalDirective({
        productName: analyzed?.productName,
        mainIngredient: analyzed?.mainIngredient,
        visualMood: analyzed?.visualMood,
        dynamicElements: analyzed?.dynamicElements,
        colorPalette: analyzed?.colorPalette,
        backgroundStyle: analyzed?.backgroundStyle,
      });
    return {
      product_focus: productFocusFallback,
      main_theme: mainThemeFallback,
      visual_mood: normalizeAiSuggestionValue(analyzed?.visualMood || ''),
      dynamic_elements: normalizeAiSuggestionValue(analyzed?.dynamicElements || ''),
      color_palette: normalizeAiSuggestionValue(analyzed?.colorPalette || ''),
      background_environment: normalizeAiSuggestionValue(analyzed?.backgroundStyle || ''),
      brand_name: normalizeAiSuggestionValue(analyzed?.brandName || analyzed?.productName || ''),
      lighting: normalizeAiSuggestionValue(lightingMap[lightingRaw] || ''),
      format: normalizeAiSuggestionValue(format),
      cta: normalizeAiSuggestionValue(normalizedCta),
      additional_directives: additionalDirectives,
    };
  };

  const buildWizardAiOptionSuggestions = async (analyzed, aiSuggestions, provider = 'gemini') => {
    const stepKeys = TELEGRAM_WIZARD_STEPS
      .map((step) => step.key)
      .filter((key) => key !== 'brand_logo_file');
    const globalFallbackSeed =
      normalizeAiSuggestionValue(aiSuggestions?.product_focus) ||
      normalizeAiSuggestionValue(aiSuggestions?.main_theme) ||
      normalizeAiSuggestionValue(aiSuggestions?.visual_mood) ||
      'Premium';
    const fallbackOptions = {};
    for (const key of stepKeys) {
      const seed = normalizeAiSuggestionValue(aiSuggestions?.[key]) || globalFallbackSeed;
      fallbackOptions[key] = buildFallbackAiOptionsForStep(key, seed);
    }

    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
    const prompt = [
      'Generate STRICT JSON only.',
      'Return keys exactly:',
      stepKeys.join(', '),
      'Each key must be an array with 3 short suggestion strings.',
      `For cta key, suggestions must be chosen only from: ${ALLOWED_CTA_VALUES.join(', ')}.`,
      'No numbering. No explanation. No markdown.',
      'Keep each suggestion under 50 characters.',
      'Base suggestions on this analyzed image context JSON:',
      JSON.stringify(analyzed || {}),
    ].join(' ');
    const normalizeOptionPayload = (parsed) => {
      const normalized = {};
      for (const key of stepKeys) {
        const aiOptions = key === 'cta'
          ? normalizeCtaOptionList(parsed?.[key])
          : normalizeAiOptionList(parsed?.[key]);
        normalized[key] = aiOptions.length ? aiOptions : fallbackOptions[key];
      }
      return normalized;
    };

    try {
      if (provider === 'gemini') {
        const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
        if (!geminiApiKey) {
          return fallbackOptions;
        }
        const geminiModels = buildGeminiModelFallbackList([
          String(process.env.GEMINI_ANALYZE_MODEL || 'gemini-2.5-pro').trim(),
          String(process.env.GEMINI_TEXT_MODEL || '').trim(),
          'gemini-2.5-pro',
          'gemini-2.5-flash',
          String(process.env.GEMINI_MODEL || '').trim(),
        ]);

        const { response } = await postGeminiWithModelFallback({
          models: geminiModels,
          apiKey: geminiApiKey,
          payload: {
            contents: [
              {
                role: 'user',
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.25,
            },
          },
          purpose: 'Telegram wizard option suggestions',
        });
        const raw = extractGeminiText(response.data).trim();
        const parsed = safeJsonParse(raw) || {};
        return normalizeOptionPayload(parsed);
      }

      const completion = await openai.chat.completions.create({
        model: openaiModel,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a JSON generator for ad prompt options.' },
          { role: 'user', content: prompt },
        ],
      });
      const raw = getMessageText(completion.choices?.[0]?.message).trim();
      const parsed = safeJsonParse(raw) || {};
      return normalizeOptionPayload(parsed);
    } catch (error) {
      return fallbackOptions;
    }
  };

  const buildAiSuggestionPreview = (suggestions) => {
    const product = normalizeAiSuggestionValue(
      suggestions?.product_focus || suggestions?.main_theme || suggestions?.dynamic_elements || ''
    );
    const theme = normalizeAiSuggestionValue(suggestions?.main_theme || '');
    const mood = normalizeAiSuggestionValue(suggestions?.visual_mood || '');
    const lighting = normalizeAiSuggestionValue(suggestions?.lighting || '');
    const format = normalizeAiSuggestionValue(suggestions?.format || '');
    const dynamic = normalizeAiSuggestionValue(suggestions?.dynamic_elements || '');
    const palette = normalizeAiSuggestionValue(suggestions?.color_palette || '');
    const background = normalizeAiSuggestionValue(suggestions?.background_environment || '');
    const brandTextOverlay = normalizeAiSuggestionValue(suggestions?.brand_name || '');
    const cta = normalizeCtaChoice(suggestions?.cta || '', '');
    const note = normalizeAiSuggestionValue(suggestions?.additional_directives || '');

    if (!product && !theme && !mood && !dynamic && !background) {
      return 'AI could not infer clear suggestions from this image. Continue manually.';
    }

    const lines = [
      '\u{2728} AI Suggestions Ready!',
      '\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}\u{2501}',
      '\u{1F4E6} Product: ' + (product || 'N/A'),
      '\u{1F3A8} Theme: ' + (theme || 'N/A'),
    ];
    if (mood) {
      lines.push('\u{1F3AD} Mood: ' + mood);
    }
    if (dynamic) {
      lines.push('\u{26A1} Dynamic: ' + dynamic);
    }
    if (palette) {
      lines.push('\u{1F3A8} Palette: ' + palette);
    }
    if (background) {
      lines.push('\u{1F5BC}\u{FE0F} Background: ' + background);
    }
    if (brandTextOverlay) {
      lines.push('\u{1F4DD} Brand Text: ' + brandTextOverlay);
    }
    if (lighting) {
      lines.push('\u{1F4A1} Lighting: ' + lighting);
    }
    if (format) {
      lines.push('\u{1F4D0} Format: ' + format);
    }
    if (cta && cta !== 'None') {
      lines.push('\u{1F4E3} CTA: ' + cta);
    }
    if (note) {
      lines.push('\u{1F4DD} Note: ' + note);
    }

    return [
      ...lines,
      '',
      '\u{1F447} Pick an option below to proceed or type to customize.',
    ].join('\n');
  };

  const buildWizardReplyMarkup = (step, draft = {}) => {
    if (step?.key === 'brand_logo_file' || step?.key === 'additional_directives') {
      return Markup.keyboard([['\u{23ED}\u{FE0F} Skip', TELEGRAM_MENU_LABELS.cancel]]).resize();
    }
    const aiOptions = getAiOptionCandidatesForStep(draft, step?.key);
    const defaultOptions = Array.isArray(step?.options) ? step.options.filter(Boolean) : [];
    const rows = [];
    const hasAnyAiSuggestions = Object.keys(getDraftAiSuggestions(draft)).length > 0;
    const useTemplateOnlyOptions = step?.key === 'format' || step?.key === 'cta';
    const useAiOptionsForStep = hasAnyAiSuggestions && !useTemplateOnlyOptions;
    const isFirstInputStep = step?.state === TELEGRAM_WIZARD_STEPS[0]?.state;
    const options = (() => {
      if (useAiOptionsForStep) {
        const fallbackSeed =
          normalizeAiSuggestionValue(getAiSuggestionForStep(draft, step?.key)) ||
          normalizeAiSuggestionValue(getAiSuggestionForStep(draft, 'product_focus')) ||
          normalizeAiSuggestionValue(getAiSuggestionForStep(draft, 'main_theme')) ||
          normalizeAiSuggestionValue(getAiSuggestionForStep(draft, 'visual_mood')) ||
          'Premium';
        const fallbackAiOptions = buildFallbackAiOptionsForStep(step?.key, fallbackSeed);
        const resolvedAiOptions = aiOptions.length ? aiOptions : fallbackAiOptions;
        if (step?.key === 'color_palette' || step?.key === 'background_environment') {
          const primaryCandidate = normalizeAiSuggestionValue(resolvedAiOptions[0] || fallbackSeed);
          return primaryCandidate ? [`AI suggestion: ${primaryCandidate}`] : [];
        }
        return resolvedAiOptions.map((candidate) => `AI suggestion: ${candidate}`);
      }
      return defaultOptions.map((item) => `Example: ${item}`);
    })();
    if (isFirstInputStep && draft?.reference_image_url && !hasAnyAiSuggestions) {
      rows.push([TELEGRAM_MENU_LABELS.fillAi]);
    }
    if (!options.length) {
      rows.push(['\u{23ED}\u{FE0F} Skip', TELEGRAM_MENU_LABELS.cancel]);
      return Markup.keyboard(rows).resize();
    }
    rows.push(...options.map((item) => [item]));
    rows.push(['\u{23ED}\u{FE0F} Skip', TELEGRAM_MENU_LABELS.cancel]);
    return Markup.keyboard(rows).resize();
  };

  const setUserWizardState = async (userId, nextState, nextDraft) => {
    const updatedResult = await pool.query(
      `
        UPDATE users
        SET bot_state = $2,
            bot_data = jsonb_set(COALESCE(bot_data, '{}'::jsonb), '{generation_draft}', $3::jsonb, true),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [userId, nextState, JSON.stringify(nextDraft || {})]
    );
    return updatedResult.rows[0] || null;
  };

  const clearUserWizardState = async (userId, nextState = BOT_STATE_IDLE) => {
    const updatedResult = await pool.query(
      `
        UPDATE users
        SET bot_state = $2,
            bot_data = COALESCE(bot_data, '{}'::jsonb) - 'generation_draft',
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [userId, nextState]
    );
    return updatedResult.rows[0] || null;
  };

  const getWizardFirstInputState = () => TELEGRAM_WIZARD_STEPS[0]?.state || BOT_STATE_WIZARD_READY;

  const sanitizePendingAdvanceState = (stateValue) => {
    const normalized = String(stateValue || '').trim().toUpperCase();
    if (normalized === BOT_STATE_WIZARD_READY || isWizardInputState(normalized)) {
      return normalized;
    }
    return getWizardFirstInputState();
  };

  const buildSimpleModeAutoDraft = ({
    draft,
    aiSuggestions,
    aiOptionSuggestions,
    analyzed,
    analyzeProvider,
  }) => {
    const baseProduct = normalizeAiSuggestionValue(
      aiSuggestions?.product_focus || analyzed?.productName || analyzed?.mainIngredient || 'Premium product hero'
    );
    const productFocus = baseProduct || 'Premium product hero';
    const mainTheme = normalizeAiSuggestionValue(
      aiSuggestions?.main_theme || analyzed?.mainIngredient || productFocus
    ) || productFocus;
    const visualMood = normalizeAiSuggestionValue(
      aiSuggestions?.visual_mood || analyzed?.visualMood || 'premium cinematic'
    ) || 'premium cinematic';
    const dynamicElements = normalizeAiSuggestionValue(
      aiSuggestions?.dynamic_elements || analyzed?.dynamicElements || 'subtle premium motion'
    ) || 'subtle premium motion';
    const colorPalette = normalizeAiSuggestionValue(
      aiSuggestions?.color_palette || analyzed?.colorPalette || 'balanced brand-matched tones'
    ) || 'balanced brand-matched tones';
    const backgroundEnvironment = normalizeAiSuggestionValue(
      aiSuggestions?.background_environment || analyzed?.backgroundStyle || 'luxury studio backdrop'
    ) || 'luxury studio backdrop';
    const brandName = normalizeAiSuggestionValue(aiSuggestions?.brand_name || analyzed?.brandName || '');
    const lighting = normalizeAiSuggestionValue(aiSuggestions?.lighting || 'Softbox') || 'Softbox';
    const formatRaw = normalizeAiSuggestionValue(aiSuggestions?.format || '');
    const format = ['1:1', '4:5', '9:16', '16:9'].includes(formatRaw) ? formatRaw : '1:1';
    // For Telegram simple auto/reference flow, keep CTA disabled unless the user
    // explicitly sets it in the guided Advance mode.
    const cta = 'None';
    const additionalDirectives = normalizeAiSuggestionValue(
      aiSuggestions?.additional_directives || analyzed?.extraNotes || ''
    ) || buildAutoAdditionalDirective({
      product_focus: productFocus,
      main_theme: mainTheme,
      visual_mood: visualMood,
      dynamic_elements: dynamicElements,
      color_palette: colorPalette,
      background_environment: backgroundEnvironment,
    });

    return {
      ...draft,
      wizard_mode: 'simple',
      pending_advance_state: '',
      product_focus: productFocus,
      main_theme: mainTheme,
      visual_mood: visualMood,
      dynamic_elements: dynamicElements,
      color_palette: colorPalette,
      background_environment: backgroundEnvironment,
      brand_name: brandName,
      lighting,
      format,
      cta,
      additional_directives: additionalDirectives,
      ai_suggestions: aiSuggestions,
      ai_option_suggestions: aiOptionSuggestions,
      ai_analysis_meta:
        analyzed?.analysisMeta && typeof analyzed.analysisMeta === 'object'
          ? analyzed.analysisMeta
          : { provider: analyzeProvider },
      ai_suggestions_updated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  };

  const promptWizardModeSelection = async ({
    ctx,
    dbUser,
    draft,
    preferredAdvanceState,
  }) => {
    const nextDraft = {
      ...draft,
      wizard_mode: '',
      pending_advance_state: sanitizePendingAdvanceState(preferredAdvanceState),
      status: 'collecting',
      updated_at: new Date().toISOString(),
    };
    await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_MODE_SELECT, nextDraft);
    await ctx.reply(
      [
        'Choose a mode:',
        `${TELEGRAM_MENU_LABELS.simpleMode} - Auto analyze, auto-fill, and generate now.`,
        `${TELEGRAM_MENU_LABELS.advanceMode} - Keep the guided wizard flow.`,
      ].join('\n'),
      buildWizardModeSelectionKeyboard()
    );
    return nextDraft;
  };

  const getUserWizardRuntimeState = async (userId) => {
    const result = await pool.query(
      `
        SELECT bot_state, bot_data
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );
    if (!result.rowCount) {
      return null;
    }
    const row = result.rows[0] || {};
    const botState = normalizeBotState(row.bot_state);
    const botData = row?.bot_data && typeof row.bot_data === 'object' ? row.bot_data : {};
    const draft = botData?.generation_draft && typeof botData.generation_draft === 'object'
      ? botData.generation_draft
      : null;
    return { botState, draft };
  };

  const isWizardActiveRuntimeState = (botState) =>
    botState === BOT_STATE_WIZARD_WAITING_REFERENCE ||
    botState === BOT_STATE_WIZARD_MODE_SELECT ||
    botState === BOT_STATE_SIMPLE_REFERENCE_DECISION ||
    botState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE ||
    botState === BOT_STATE_WIZARD_READY ||
    isWizardInputState(botState);

  const promptReferenceDecisionAfterProductUpload = async ({
    ctx,
    dbUser,
    draft,
  }) => {
    const nextDraft = {
      ...draft,
      wizard_mode: '',
      status: 'awaiting_reference_decision',
      updated_at: new Date().toISOString(),
    };
    await setUserWizardState(dbUser.id, BOT_STATE_SIMPLE_REFERENCE_DECISION, nextDraft);
    await ctx.reply(
      [
        '\u{2705} Product Image Received.',
        'Do you want to add a reference image for background matching?',
        `If yes, tap ${TELEGRAM_MENU_LABELS.yesReference}.`,
        `If no, tap ${TELEGRAM_MENU_LABELS.noReference} to continue to Simple/Advance mode selection.`,
      ].join('\n'),
      buildSimpleReferenceDecisionKeyboard()
    );
    return nextDraft;
  };

  const sendWizardStepPrompt = async (ctx, stateValue, draftOverride = null) => {
    const step = getWizardStepByState(stateValue);
    if (!step) {
      await ctx.reply('Wizard step not found. Run /new to restart.');
      return;
    }
    const draft = draftOverride || getUserDraft(ctx.state.dbUser);
    const aiSuggestion = getAiSuggestionForStep(draft, step.key);
    const hasAiOptions = getAiOptionCandidatesForStep(draft, step.key).length > 0;
    const hasAnyAiSuggestions = Object.keys(getDraftAiSuggestions(draft)).length > 0;
    const isFirstInputStep = step?.state === TELEGRAM_WIZARD_STEPS[0]?.state;
    const progressMeta = getWizardStepProgressMeta(step.state);
    const stepLine = progressMeta
      ? `Step ${progressMeta.stepNumber} of ${progressMeta.totalSteps} ${progressMeta.progressBar}`
      : step.prompt;
    const stepTitleByKey = {
      product_focus: '\u{1F3F7}\u{FE0F} Product Focus',
      main_theme: '\u{1F3A8} Main Theme',
      visual_mood: '\u{1F9ED} Visual Mood',
      dynamic_elements: '\u{26A1} Dynamic Elements',
      color_palette: '\u{1F3A8} Color Palette',
      background_environment: '\u{1F5BC}\u{FE0F} Background Environment',
      brand_name: '\u{1F4DD} Brand Text Overlay',
      lighting: '\u{1F4A1} Lighting',
      format: '\u{1F4D0} Format',
      cta: '\u{1F4E3} Call To Action',
      additional_directives: '\u{1F4DD} Additional Directives',
      brand_logo_file: '\u{1F5BC}\u{FE0F} Brand Logo (Optional)',
    };
    const stepTitle = stepTitleByKey[step.key] || `\u{1F3F7}\u{FE0F} ${step.label || 'Wizard Step'}`;
    const baseHelp = String(step.help || '').trim();
    const helpLine = (() => {
      if (!baseHelp) {
        return '';
      }
      if (hasAnyAiSuggestions && /^example\s*:/i.test(baseHelp)) {
        return '';
      }
      if (/^example\s*:/i.test(baseHelp)) {
        return `\n${baseHelp}`;
      }
      return `\n${baseHelp}`;
    })();
    const displayedAiSuggestion = (() => {
      if (step.key === 'additional_directives') {
        return normalizeAiSuggestionValue(draft?.additional_directives) ||
          aiSuggestion ||
          buildAutoAdditionalDirective(draft);
      }
      return aiSuggestion ||
        (hasAnyAiSuggestions ? getAiOptionCandidatesForStep(draft, step.key)[0] || '' : '');
    })();
    const suggestionHint = displayedAiSuggestion
      ? `\n\u{1F4A1} Suggested: ${displayedAiSuggestion}`
      : isFirstInputStep && step.key !== 'brand_logo_file' && draft?.reference_image_url && !hasAnyAiSuggestions
        ? `\nTip: tap "${TELEGRAM_MENU_LABELS.fillAi}" for AI suggestions.`
        : '';
    const optionsHint = (hasAnyAiSuggestions || hasAiOptions) ? '\n\u{1F447} Pick an option below or type to customize.' : '';
    await ctx.reply(
      `${stepLine}\n${stepTitle}${helpLine}${suggestionHint}${optionsHint}`,
      buildWizardReplyMarkup(step, draft)
    );
  };

  const startGuidedWizard = async (ctx, dbUser) => {
    const initializedDraft = {
      created_at: new Date().toISOString(),
      status: 'collecting',
      reference_image_url: '',
      reference_telegram_file_id: '',
      reference_mode: 'edit',
      simple_reference_enabled: false,
      simple_reference_image_url: '',
      simple_reference_telegram_file_id: '',
      simple_reference_mime_type: '',
      simple_reference_source_kind: '',
      simple_reference_file_name: '',
      product_focus: '',
      main_theme: '',
      visual_mood: '',
      dynamic_elements: '',
      color_palette: '',
      background_environment: '',
      brand_name: '',
      lighting: '',
      format: '1:1',
      cta: 'None',
      additional_directives: '',
      brand_logo_file: '',
      brand_logo_telegram_file_id: '',
      brand_logo_mime_type: '',
      brand_logo_source_kind: '',
      brand_logo_file_name: '',
      brand_logo_has_transparency: false,
    };

    await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_WAITING_REFERENCE, initializedDraft);
    await ctx.reply(
      '\u{1F9ED} Wizard started.\nStep 1/13: Send your background-removed PNG as a Document/File (not photo).'
    );
  };

  const runTelegramGenerationFromReference = async ({
    ctx,
    dbUser,
    telegramId,
    productImageUrl,
    productDataUrl,
    referenceImageUrl = '',
    referenceDataUrl = '',
    logoImageDataUrl,
    brandTextOverlay,
    referenceMode,
    resolvedMimeType,
    sourceKind,
    originalFileName,
    prompt,
    variantCount = TELEGRAM_GENERATION_VARIANT_COUNT,
    shouldDeductCredits = true,
    sendProgressMessages = true,
  }) => {
    const shouldChargeCredits = shouldDeductCredits && !isUsageLimitExemptUser(dbUser);
    const activeTelegramBotUsername = String(process.env.TELEGRAM_BOT_USERNAME || '').trim();
    const projectResult = await pool.query(
      `
        INSERT INTO projects (owner_user_id, name, description, status)
        VALUES ($1, $2, $3, 'active')
        RETURNING id
      `,
      [
        dbUser.id,
        `Telegram Upload ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        sourceKind === 'document'
          ? `Auto-created from Telegram file upload (telegram_id: ${telegramId || 'unknown'}${activeTelegramBotUsername ? `, bot: @${activeTelegramBotUsername.replace(/^@/, '')}` : ''})`
          : `Auto-created from Telegram photo upload (telegram_id: ${telegramId || 'unknown'}${activeTelegramBotUsername ? `, bot: @${activeTelegramBotUsername.replace(/^@/, '')}` : ''})`,
      ]
    );
    const projectId = projectResult.rows[0].id;

    const referenceAssetResult = await pool.query(
      `
        INSERT INTO assets (
          project_id,
          uploaded_by_user_id,
          asset_type,
          storage_provider,
          storage_key,
          public_url,
          mime_type,
          metadata
        )
        VALUES ($1, $2, 'reference_image', 'local', $3, $4, $5, $6::jsonb)
        RETURNING id
      `,
      [
        projectId,
        dbUser.id,
        `telegram/${telegramId}/ref-${Date.now()}`,
        productImageUrl,
        resolvedMimeType || 'image/png',
        JSON.stringify({
          source_kind: sourceKind || 'document',
          original_file_name: originalFileName || null,
          reference_mode: referenceMode || 'auto',
          has_reference_image: Boolean(String(referenceImageUrl || '').trim()),
          telegram_id: String(telegramId || '').trim() || null,
          telegram_bot_username: activeTelegramBotUsername || null,
        }),
      ]
    );
    const referenceAssetId = referenceAssetResult.rows[0].id;

    const safeVariantCount = Number.isFinite(Number(variantCount))
      ? Math.max(1, Math.floor(Number(variantCount)))
      : TELEGRAM_GENERATION_VARIANT_COUNT;
    const processedResults = [];
    let lastError = null;

    for (let index = 0; index < safeVariantCount; index += 1) {
      try {
        const processed = await processProductImage({
          userId: dbUser.id,
          projectId,
          referenceAssetId,
          productImageUrl,
          productImageDataUrl: productDataUrl,
          referenceImageUrl,
          referenceImageDataUrl: referenceDataUrl,
          logoImageDataUrl,
          brandTextOverlay,
          referenceMode,
          prompt,
          sendProgressUpdate: (sendProgressMessages && index === 0)
            ? async (_step, message) => {
              await ctx.reply(`\u{1F4A0} ${message}`);
            }
            : null,
        });
        processedResults.push(processed);
      } catch (error) {
        lastError = error;
        console.warn(`[Telegram] Variant ${index + 1}/${variantCount} failed: ${error.message}`);
      }
    }

    if (!processedResults.length) {
      throw new Error(lastError?.message || 'Failed to generate image variants');
    }
    if (processedResults.length < safeVariantCount) {
      throw new Error(lastError?.message || 'Could not generate both variants. Please try again.');
    }
    if (sendProgressMessages) {
      await ctx.reply(
        processedResults.length === 1
          ? '\u{2705} Generated 1 output. Sending result now.'
          : `\u{2705} Generated ${processedResults.length} variants. Sending results now.`
      );
    }
    for (let index = 0; index < processedResults.length; index += 1) {
      const item = processedResults[index];
      const caption = processedResults.length === 1
        ? (item.caption || 'Generated output')
        : (
          item.caption
            ? `[Variant ${index + 1}/${processedResults.length}] ${item.caption}`
            : `Variant ${index + 1}/${processedResults.length}`
        );
      await sendGeneratedPhoto(ctx, item.imageUrl, caption);
    }

    const usedCredits = processedResults.length;
    let remainingCredits = Number(dbUser.credits || 0);
    if (shouldChargeCredits) {
      const creditUpdateResult = await pool.query(
        `
          UPDATE users
          SET credits = GREATEST(credits - $2, 0)
          WHERE id = $1
          RETURNING credits
        `,
        [dbUser.id, usedCredits]
      );
      remainingCredits = Number(creditUpdateResult.rows[0]?.credits ?? remainingCredits);
    } else {
      const currentCreditResult = await pool.query(
        `
          SELECT credits
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [dbUser.id]
      );
      if (currentCreditResult.rowCount) {
        remainingCredits = Number(currentCreditResult.rows[0]?.credits ?? remainingCredits);
      }
    }
    return {
      remainingCredits,
      usedCredits,
      generatedCount: processedResults.length,
      runIds: processedResults.map((item) => item.runId).filter(Boolean),
    };
  };

  let telegramJobWorkerTimer = null;
  let telegramJobWorkerBusy = false;

  const createTelegramJobToken = () =>
    `TG-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

  const createTelegramChatResponder = (chatIdValue) => {
    const chatId = String(chatIdValue || '').trim();
    if (!chatId) {
      return null;
    }
    return {
      reply: async (text, extra) => {
        try {
          await bot.telegram.sendMessage(chatId, text, extra);
        } catch (error) {
          console.warn(`Telegram notify failed (${chatId}):`, error.message);
        }
      },
      replyWithDocument: async (document, extra) => {
        try {
          await bot.telegram.sendDocument(chatId, document, extra);
        } catch (error) {
          console.warn(`Telegram document send failed (${chatId}):`, error.message);
        }
      },
      replyWithPhoto: async (photo, extra) => {
        try {
          await bot.telegram.sendPhoto(chatId, photo, extra);
        } catch (error) {
          console.warn(`Telegram photo send failed (${chatId}):`, error.message);
        }
      },
    };
  };

  const createNoopResponder = () => ({
    reply: async () => {},
    replyWithDocument: async () => {},
    replyWithPhoto: async () => {},
  });

  const withTimeout = async (promise, timeoutMs, timeoutMessage) =>
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(timeoutMessage || `Operation timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      Promise.resolve(promise)
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });

  const cleanupStaleTelegramJobs = async (userId = null) => {
    const params = [TELEGRAM_STALE_JOB_GRACE_MS];
    const userFilter = userId ? 'AND user_id = $2' : '';
    if (userId) {
      params.push(userId);
    }
    const staleResult = await pool.query(
      `
        UPDATE telegram_generation_jobs
        SET status = 'failed',
            error_text = 'Timed out while processing. Please try again.',
            finished_at = NOW(),
            updated_at = NOW()
        WHERE status IN ('queued', 'running')
          ${userFilter}
          AND COALESCE(started_at, queued_at, created_at) < NOW() - ($1::bigint * INTERVAL '1 millisecond')
      `,
      params
    );
    return Number(staleResult.rowCount || 0);
  };

  const cancelActiveTelegramJobsForUser = async (userId, reason = 'Cancelled by user') => {
    const result = await pool.query(
      `
        UPDATE telegram_generation_jobs
        SET status = 'cancelled',
            error_text = $2,
            finished_at = NOW(),
            updated_at = NOW()
        WHERE user_id = $1
          AND status IN ('queued', 'running')
      `,
      [userId, String(reason || 'Cancelled by user').slice(0, 500)]
    );
    return Number(result.rowCount || 0);
  };

  const enqueueTelegramGenerationJob = async ({
    dbUser,
    telegramId,
    chatId,
    prompt,
    draft,
    variantCount,
  }) => {
    const safeVariantCount = Number.isFinite(Number(variantCount))
      ? Math.max(1, Math.floor(Number(variantCount)))
      : TELEGRAM_GENERATION_VARIANT_COUNT;
    const jobToken = createTelegramJobToken();

    await pool.query(
      `
        INSERT INTO telegram_generation_jobs (
          job_token,
          user_id,
          telegram_id,
          chat_id,
          status,
          prompt,
          reference_image_url,
          reference_mime_type,
          reference_source_kind,
          reference_file_name,
          reference_mode,
          logo_image_url,
          logo_mime_type,
          draft_snapshot,
          variant_count,
          reserved_credits,
          queued_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3::bigint,
          $4::bigint,
          'queued',
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13::jsonb,
          $14::smallint,
          $15::integer,
          NOW(),
          NOW()
        )
      `,
      [
        jobToken,
        dbUser.id,
        telegramId,
        chatId,
        String(prompt || '').trim(),
        String(draft?.reference_image_url || '').trim(),
        String(draft?.reference_mime_type || 'image/png').trim(),
        String(draft?.reference_source_kind || 'document').trim(),
        String(draft?.reference_file_name || '').trim(),
        draft?.simple_reference_enabled ? 'auto' : 'edit',
        String(draft?.brand_logo_file || '').trim() || null,
        String(draft?.brand_logo_mime_type || '').trim() || null,
        JSON.stringify(draft && typeof draft === 'object' ? draft : {}),
        safeVariantCount,
        0,
      ]
    );

    return jobToken;
  };

  const claimNextQueuedTelegramJob = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const queuedResult = await client.query(
        `
          SELECT *
          FROM telegram_generation_jobs
          WHERE status = 'queued'
          ORDER BY queued_at ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `
      );

      if (!queuedResult.rowCount) {
        await client.query('ROLLBACK');
        return null;
      }

      const queuedJob = queuedResult.rows[0];
      const runningResult = await client.query(
        `
          UPDATE telegram_generation_jobs
          SET status = 'running',
              started_at = NOW(),
              updated_at = NOW()
          WHERE job_token = $1
          RETURNING *
        `,
        [queuedJob.job_token]
      );
      await client.query('COMMIT');
      return runningResult.rows[0] || null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const TELEGRAM_JOB_CANCELLED_MARKER = 'telegram_job_cancelled';
  const createTelegramJobCancelledError = () => {
    const error = new Error(TELEGRAM_JOB_CANCELLED_MARKER);
    error.code = TELEGRAM_JOB_CANCELLED_MARKER;
    return error;
  };
  const isTelegramJobCancelledError = (error) =>
    String(error?.code || '').toLowerCase() === TELEGRAM_JOB_CANCELLED_MARKER ||
    String(error?.message || '').toLowerCase() === TELEGRAM_JOB_CANCELLED_MARKER;
  const getTelegramFriendlyGenerationError = (error) => {
    const raw = String(error?.message || '').trim();
    const normalized = raw.toLowerCase();
    if (
      normalized.includes('unauthorized') ||
      normalized.includes('status code 503') ||
      normalized.includes('service unavailable') ||
      normalized.includes('high demand') ||
      normalized.includes('upstream service unavailable')
    ) {
      return 'Our service is now in high demand. Please try again in a few minutes.';
    }
    return raw || 'Unexpected error';
  };
  const ensureTelegramJobIsRunning = async (jobToken) => {
    const statusResult = await pool.query(
      `
        SELECT status
        FROM telegram_generation_jobs
        WHERE job_token = $1
        LIMIT 1
      `,
      [jobToken]
    );
    const status = String(statusResult.rows[0]?.status || '').toLowerCase();
    if (!statusResult.rowCount || status !== 'running') {
      throw createTelegramJobCancelledError();
    }
  };

  const processQueuedTelegramJob = async (jobRow) => {
    const jobToken = String(jobRow?.job_token || '').trim();
    if (!jobToken) {
      return;
    }

    const chatId = String(jobRow.chat_id || jobRow.telegram_id || '').trim();
    const responder = createTelegramChatResponder(chatId) || createNoopResponder();
    const variantCount = Number.isFinite(Number(jobRow.variant_count))
      ? Math.max(1, Math.floor(Number(jobRow.variant_count)))
      : TELEGRAM_GENERATION_VARIANT_COUNT;

    try {
      await ensureTelegramJobIsRunning(jobToken);

      const userResult = await pool.query(
        `
          SELECT *
          FROM users
          WHERE id = $1
          LIMIT 1
        `,
        [jobRow.user_id]
      );
      if (!userResult.rowCount) {
        throw new Error('User not found for queued generation job');
      }

      const dbUser = userResult.rows[0];
      if (!isUsageLimitExemptUser(dbUser) && Number(dbUser.credits || 0) < variantCount) {
        throw new Error(`Insufficient credits. Required: ${variantCount}, Available: ${Number(dbUser.credits || 0)}`);
      }
      const draft = jobRow.draft_snapshot && typeof jobRow.draft_snapshot === 'object'
        ? jobRow.draft_snapshot
        : {};
      const productUrl = String(jobRow.reference_image_url || '').trim();
      const productFileId = String(draft.reference_telegram_file_id || '').trim();
      if (!productUrl && !productFileId) {
        throw new Error('Product image is missing for queued job');
      }

      await ensureTelegramJobIsRunning(jobToken);
      const resolvedProductImage = await resolveTelegramImageDataUrl({
        telegramClient: bot.telegram,
        fileId: productFileId,
        fallbackUrl: productUrl,
        fallbackMimeType: String(jobRow.reference_mime_type || draft.reference_mime_type || 'image/png'),
        assetLabel: 'product PNG',
      });
      const productDataUrl = resolvedProductImage.dataUrl;
      const resolvedProductUrl = String(resolvedProductImage.resolvedUrl || productUrl).trim();

      let referenceDataUrl = '';
      let resolvedReferenceUrl = '';
      const optionalReferenceFileId = String(draft.simple_reference_telegram_file_id || '').trim();
      const optionalReferenceUrl = String(draft.simple_reference_image_url || '').trim();
      if (optionalReferenceFileId || optionalReferenceUrl) {
        const resolvedReferenceImage = await resolveTelegramImageDataUrl({
          telegramClient: bot.telegram,
          fileId: optionalReferenceFileId,
          fallbackUrl: optionalReferenceUrl,
          fallbackMimeType: String(draft.simple_reference_mime_type || 'image/png'),
          assetLabel: 'reference image',
        });
        referenceDataUrl = resolvedReferenceImage.dataUrl;
        resolvedReferenceUrl = String(resolvedReferenceImage.resolvedUrl || optionalReferenceUrl).trim();
      }

      let logoImageDataUrl = '';
      const logoUrl = String(jobRow.logo_image_url || '').trim();
      if (logoUrl) {
        const resolvedLogoImage = await resolveTelegramImageDataUrl({
          telegramClient: bot.telegram,
          fileId: String(draft.brand_logo_telegram_file_id || '').trim(),
          fallbackUrl: logoUrl,
          fallbackMimeType: String(jobRow.logo_mime_type || draft.brand_logo_mime_type || 'image/png'),
          assetLabel: 'logo PNG',
        });
        logoImageDataUrl = resolvedLogoImage.dataUrl;
      }

      await ensureTelegramJobIsRunning(jobToken);
      const generationResult = await withTimeout(
        runTelegramGenerationFromReference({
          ctx: responder,
          dbUser,
          telegramId: String(jobRow.telegram_id || ''),
          productImageUrl: resolvedProductUrl,
          productDataUrl,
          referenceImageUrl: resolvedReferenceUrl,
          referenceDataUrl,
          logoImageDataUrl,
          brandTextOverlay: normalizeBrandOverlayText(draft.brand_name || ''),
          referenceMode: String(jobRow.reference_mode || 'auto'),
          resolvedMimeType: String(jobRow.reference_mime_type || 'image/png'),
          sourceKind: String(jobRow.reference_source_kind || 'document'),
          originalFileName: String(jobRow.reference_file_name || ''),
          prompt: String(jobRow.prompt || ''),
          variantCount,
          shouldDeductCredits: true,
          sendProgressMessages: true,
        }),
        TELEGRAM_JOB_MAX_RUNTIME_MS,
        `Generation timed out after ${Math.round(TELEGRAM_JOB_MAX_RUNTIME_MS / 1000)}s`
      );

      const successUpdate = await pool.query(
        `
          UPDATE telegram_generation_jobs
          SET status = 'succeeded',
              generated_count = $2,
              result_payload = $3::jsonb,
              finished_at = NOW(),
              updated_at = NOW()
          WHERE job_token = $1
            AND status = 'running'
        `,
        [
          jobToken,
          Number(generationResult.generatedCount || 0),
          JSON.stringify({
            remainingCredits: Number(generationResult.remainingCredits || 0),
            usedCredits: Number(generationResult.usedCredits || 0),
            runIds: generationResult.runIds || [],
          }),
        ]
      );
      if (!successUpdate.rowCount) {
        return;
      }

      const usedCredits = Number(generationResult.usedCredits || generationResult.generatedCount || 0);
      const remainingCredits = Number(generationResult.remainingCredits || 0);
      const usedCreditLabel = usedCredits === 1 ? 'credit' : 'credits';
      await responder.reply(
        `\u{2705} Done! Your ads are ready.\n\u{1F4B3} ${usedCredits} ${usedCreditLabel} used | Remaining: ${remainingCredits}`,
        buildTelegramPostGenerationKeyboard()
      );
    } catch (error) {
      if (isTelegramJobCancelledError(error)) {
        return;
      }
      const errorText = getTelegramFriendlyGenerationError(error).slice(0, 1000);

      const failedUpdate = await pool.query(
        `
          UPDATE telegram_generation_jobs
          SET status = 'failed',
              error_text = $2,
              result_payload = $3::jsonb,
              finished_at = NOW(),
              updated_at = NOW()
          WHERE job_token = $1
            AND status = 'running'
        `,
        [
          jobToken,
          errorText,
          JSON.stringify({}),
        ]
      );
      if (!failedUpdate.rowCount) {
        return;
      }

      await responder.reply(`Generation failed: ${errorText}`);
      console.error(`[Telegram job ${jobToken}] failed:`, errorText);
    }
  };

  const processTelegramGenerationQueue = async () => {
    if (telegramJobWorkerBusy) {
      return;
    }
    telegramJobWorkerBusy = true;
    try {
      await cleanupStaleTelegramJobs();
      while (true) {
        const queuedJob = await claimNextQueuedTelegramJob();
        if (!queuedJob) {
          break;
        }
        await processQueuedTelegramJob(queuedJob);
      }
    } catch (error) {
      console.error('Telegram generation worker error:', error.message);
    } finally {
      telegramJobWorkerBusy = false;
    }
  };

  const triggerTelegramGenerationQueue = () => {
    setImmediate(() => {
      void processTelegramGenerationQueue();
    });
  };

  const startTelegramGenerationWorker = () => {
    if (telegramJobWorkerTimer) {
      return;
    }
    setImmediate(async () => {
      try {
        const recovered = await pool.query(
          `
            UPDATE telegram_generation_jobs
            SET status = 'queued',
                started_at = NULL,
                updated_at = NOW()
            WHERE status = 'running'
              AND finished_at IS NULL
          `
        );
        if (Number(recovered.rowCount || 0) > 0) {
          console.warn(`Recovered ${recovered.rowCount} stale Telegram generation job(s)`);
        }
      } catch (error) {
        console.warn('Failed to recover stale Telegram jobs:', error.message);
      }
    });
    telegramJobWorkerTimer = setInterval(() => {
      void processTelegramGenerationQueue();
    }, TELEGRAM_JOB_POLL_INTERVAL_MS);
    if (typeof telegramJobWorkerTimer.unref === 'function') {
      telegramJobWorkerTimer.unref();
    }
    triggerTelegramGenerationQueue();
    console.log(`Telegram generation worker started (interval: ${TELEGRAM_JOB_POLL_INTERVAL_MS}ms)`);
  };

  const stopTelegramGenerationWorker = () => {
    if (!telegramJobWorkerTimer) {
      return;
    }
    clearInterval(telegramJobWorkerTimer);
    telegramJobWorkerTimer = null;
    console.log('Telegram generation worker stopped');
  };

  const handleFillUpWithAiCommand = async (ctx) => {
    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }

    const botState = normalizeBotState(dbUser.bot_state);
    if (botState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
      await ctx.reply('Please complete sign-in by sharing your email first.');
      return;
    }
    if (botState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
      const verificationRecord = getEmailVerificationRecord(dbUser);
      await sendEmailVerificationPrompt(ctx, verificationRecord?.pendingEmail || dbUser.email || '');
      return;
    }
    if (botState === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
      await sendPhonePrompt(ctx);
      return;
    }
    if (botState === BOT_STATE_AWAITING_PLAN_SELECTION) {
      await sendPlanSelectionPrompt(ctx, dbUser, '\u{2705} Registration Complete');
      return;
    }
    if (botState === BOT_STATE_WIZARD_MODE_SELECT) {
      await ctx.reply('Choose a mode first: Simple or Advance.', buildWizardModeSelectionKeyboard());
      return;
    }
    if (botState === BOT_STATE_SIMPLE_REFERENCE_DECISION) {
      await ctx.reply(
        `Please choose: ${TELEGRAM_MENU_LABELS.yesReference} or ${TELEGRAM_MENU_LABELS.noReference}.`,
        buildSimpleReferenceDecisionKeyboard()
      );
      return;
    }
    if (botState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE) {
      await ctx.reply('Please upload your reference image first, then generation will start automatically.');
      return;
    }

    const isWizardState =
      botState === BOT_STATE_WIZARD_WAITING_REFERENCE ||
      botState === BOT_STATE_WIZARD_READY ||
      isWizardInputState(botState);
    if (!isWizardState) {
      await ctx.reply('Start a wizard with /new, upload a PNG, then tap "Fill Up with AI".');
      return;
    }

    const draft = getUserDraft(dbUser);
    if (!draft.reference_image_url) {
      await ctx.reply('Please send your background-removed PNG as a Document/File first.');
      return;
    }
    if (isTelegramAiFillInProgress(draft)) {
      await ctx.reply('AI analysis is already running. Please wait a moment...');
      return;
    }

    const nextState =
      botState === BOT_STATE_WIZARD_WAITING_REFERENCE
        ? TELEGRAM_WIZARD_STEPS[0].state
        : botState;
    const runningDraft = applyTelegramAiFillState(draft, 'running');
    try {
      await setUserWizardState(dbUser.id, nextState, runningDraft);
    } catch (stateError) {
      console.warn('Failed to persist AI fill running state:', stateError.message);
    }

    await ctx.reply('\u{1F50D} Analyzing your image...\nCurating the best AI parameters for you.');
    try {
      const referenceImage = await resolveTelegramImageDataUrl({
        telegramClient: ctx.telegram,
        fileId: draft.reference_telegram_file_id,
        fallbackUrl: draft.reference_image_url,
        fallbackMimeType: draft.reference_mime_type || 'image/png',
        assetLabel: 'reference PNG',
      });
      const referenceDataUrl = referenceImage.dataUrl;
      const resolvedReferenceUrl = referenceImage.resolvedUrl;
      const analyzeProvider = getTelegramWizardAnalyzeProvider();
      const fastFillMode = isTelegramAdvanceFastFillEnabled();
      const analyzed = analyzeProvider === 'openai'
        ? await analyzeReferenceImageWithAi(referenceDataUrl)
        : fastFillMode
          ? await analyzeReferenceImageWithGeminiQuick(referenceDataUrl)
          : await analyzeReferenceImageWithGemini(referenceDataUrl);
      const aiSuggestions = mapAnalyzeResultToWizardSuggestions(analyzed);
      const aiOptionSuggestions = fastFillMode
        ? buildFallbackWizardAiOptionSuggestions(aiSuggestions)
        : await buildWizardAiOptionSuggestions(analyzed, aiSuggestions, analyzeProvider);
      const autoDirective = normalizeAiSuggestionValue(aiSuggestions?.additional_directives) ||
        buildAutoAdditionalDirective(aiSuggestions);
      const completedDraft = applyTelegramAiFillState(runningDraft, 'completed');
      const nextDraft = {
        ...completedDraft,
        reference_image_url: resolvedReferenceUrl || String(draft.reference_image_url || ''),
        ai_suggestions: aiSuggestions,
        ai_option_suggestions: aiOptionSuggestions,
        ai_analysis_meta:
          analyzed?.analysisMeta && typeof analyzed.analysisMeta === 'object'
            ? analyzed.analysisMeta
            : { provider: analyzeProvider, fastMode: fastFillMode },
        additional_directives: normalizeAiSuggestionValue(runningDraft?.additional_directives) || autoDirective,
        ai_suggestions_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await setUserWizardState(dbUser.id, nextState, nextDraft);
      await ctx.reply(buildAiSuggestionPreview(aiSuggestions));

      if (nextState === BOT_STATE_WIZARD_READY) {
        await ctx.reply('\u{2705} Wizard is ready. Use /generate to create images, or /new to restart.');
        return;
      }
      await sendWizardStepPrompt(ctx, nextState, nextDraft);
    } catch (error) {
      console.error('Telegram Fill Up with AI failed:', error.message);
      const failedDraft = applyTelegramAiFillState(runningDraft, 'failed', error.message || 'Unexpected error');
      try {
        await setUserWizardState(dbUser.id, nextState, failedDraft);
      } catch (stateError) {
        console.warn('Failed to persist AI fill failure state:', stateError.message);
      }
      await ctx.reply(`AI suggestion step failed: ${error.message || 'Unexpected error'}`);
    }
  };

  const queueWizardDraftGeneration = async ({
    ctx,
    dbUser,
    telegramId,
    chatId,
    draft,
    variantCount = TELEGRAM_GENERATION_VARIANT_COUNT,
    requireCompleteInputs = true,
    promptOverride = null,
  }) => {
    if (!draft?.reference_image_url) {
      await ctx.reply('Please send your background-removed PNG as a Document/File first, then run /generate.');
      return { queued: false, reason: 'missing_reference' };
    }

    const runtimeState = await getUserWizardRuntimeState(dbUser.id);
    if (!runtimeState || !isWizardActiveRuntimeState(runtimeState.botState) || !runtimeState.draft?.reference_image_url) {
      return { queued: false, reason: 'wizard_not_active' };
    }
    const activeDraft = runtimeState.draft;

    if (requireCompleteInputs) {
      const requiredKeys = ['product_focus', 'main_theme', 'visual_mood', 'background_environment'];
      const missing = requiredKeys.filter((key) => !String(activeDraft?.[key] || '').trim());
      if (missing.length) {
        await ctx.reply('Wizard inputs are incomplete. Run /new and complete all steps before /generate.');
        return { queued: false, reason: 'incomplete_inputs' };
      }
    }

    await cleanupStaleTelegramJobs(dbUser.id);

    const activeJobResult = await pool.query(
      `
        SELECT job_token
        FROM telegram_generation_jobs
        WHERE user_id = $1
          AND status IN ('queued', 'running')
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [dbUser.id]
    );
    if (activeJobResult.rowCount) {
      await ctx.reply('Your previous request is still processing. If it feels stuck, use /cancel once and run /generate again.');
      return { queued: false, reason: 'active_job' };
    }

    const latestCreditsResult = await pool.query(
      `
        SELECT credits
        FROM users
        WHERE id = $1
        LIMIT 1
      `,
      [dbUser.id]
    );
    const latestCredits = Number(latestCreditsResult.rows[0]?.credits ?? dbUser.credits ?? 0);
    if (!isUsageLimitExemptUser(dbUser) && latestCredits < variantCount) {
      await ctx.reply(`You need at least ${variantCount} credits to generate ${variantCount} images.`);
      await sendBuyPrompt(ctx, telegramId);
      return { queued: false, reason: 'insufficient_credits' };
    }

    const strictPrompt = promptOverride === null
      ? buildStrictProductPromptFromDraft(activeDraft)
      : String(promptOverride ?? '').trim();
    const queuedJobToken = await enqueueTelegramGenerationJob({
      dbUser,
      telegramId,
      chatId,
      prompt: strictPrompt,
      draft: activeDraft,
      variantCount,
    });

    const postEnqueueRuntime = await getUserWizardRuntimeState(dbUser.id);
    if (!postEnqueueRuntime || !isWizardActiveRuntimeState(postEnqueueRuntime.botState)) {
      await pool.query(
        `
          UPDATE telegram_generation_jobs
          SET status = 'cancelled',
              error_text = 'Cancelled from wizard before processing started',
              finished_at = NOW(),
              updated_at = NOW()
          WHERE job_token = $1
            AND status = 'queued'
        `,
        [queuedJobToken]
      );
      return { queued: false, reason: 'cancelled_before_queue_confirm' };
    }

    const nextDraft = {
      ...activeDraft,
      status: 'queued',
      last_generation_job_token: queuedJobToken,
      last_generation_queued_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    try {
      await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_READY, nextDraft);
    } catch (stateError) {
      console.warn('Failed to persist queued wizard state:', stateError.message);
    }

    const jobStatusCheck = await pool.query(
      `
        SELECT status
        FROM telegram_generation_jobs
        WHERE job_token = $1
        LIMIT 1
      `,
      [queuedJobToken]
    );
    const queuedStatus = String(jobStatusCheck.rows[0]?.status || '').toLowerCase();
    if (!jobStatusCheck.rowCount || (queuedStatus !== 'queued' && queuedStatus !== 'running')) {
      return { queued: false, reason: 'cancelled_after_enqueue' };
    }

    await ctx.reply(
      [
        '\u{1F504} Working on it...',
        '',
        '\u{2692}\u{FE0F} We are currently generating your images.',
        '\u{1F4E9} Sit tight. Results will appear here automatically.',
      ].join('\n')
    );

    triggerTelegramGenerationQueue();
    return { queued: true, queuedJobToken, nextDraft };
  };

  const handleAdvanceModeCommand = async (ctx) => {
    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }

    const botState = normalizeBotState(dbUser.bot_state);
    if (botState !== BOT_STATE_WIZARD_MODE_SELECT) {
      await ctx.reply('Upload your PNG first, then choose mode.', buildTelegramMainMenuKeyboardForCtx(ctx));
      return;
    }

    const draft = getUserDraft(dbUser);
    if (!draft.reference_image_url) {
      await ctx.reply('Please send your background-removed PNG as a Document/File first.');
      return;
    }

    const nextState = sanitizePendingAdvanceState(draft.pending_advance_state);
    const nextDraft = {
      ...draft,
      wizard_mode: 'advance',
      pending_advance_state: '',
      updated_at: new Date().toISOString(),
    };

    await setUserWizardState(dbUser.id, nextState, nextDraft);
    if (nextState === getWizardFirstInputState()) {
      await ctx.reply(
        'Advance mode selected. Continue manually, or tap "Fill Up with AI" for suggestions.',
        buildWizardCancelOnlyKeyboard()
      );
      await sendWizardStepPrompt(ctx, nextState, nextDraft);
      return;
    }
    if (nextState === BOT_STATE_WIZARD_READY) {
      await ctx.reply(
        'Advance mode selected. Reference image updated. Use /generate to create a new result.',
        buildWizardCancelOnlyKeyboard()
      );
      return;
    }
    await ctx.reply(
      'Advance mode selected. Reference image updated. Continue with the remaining wizard steps.',
      buildWizardCancelOnlyKeyboard()
    );
  };

  const runSimpleModeGeneration = async ({
    ctx,
    dbUser,
    telegramId,
    chatId,
    draft,
    includeReferenceImage = false,
  }) => {
    await ctx.reply(
      includeReferenceImage
        ? '\u{2705} Reference image received.\nStarting automatic processing now...'
        : '\u{26A1} Simple mode selected.\nAnalyzing product image and auto-filling everything for you...',
      buildWizardCancelOnlyKeyboard()
    );
    try {
      const productImage = await resolveTelegramImageDataUrl({
        telegramClient: ctx.telegram,
        fileId: draft.reference_telegram_file_id,
        fallbackUrl: draft.reference_image_url,
        fallbackMimeType: draft.reference_mime_type || 'image/png',
        assetLabel: 'product PNG',
      });
      const resolvedProductUrl = productImage.resolvedUrl;
      if (includeReferenceImage) {
        const nextDraft = {
          ...draft,
          wizard_mode: 'simple',
          reference_image_url: resolvedProductUrl || String(draft.reference_image_url || ''),
          status: 'ready_for_generation',
          updated_at: new Date().toISOString(),
        };
        await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_READY, nextDraft);
        await queueWizardDraftGeneration({
          ctx,
          dbUser,
          telegramId,
          chatId,
          draft: nextDraft,
          variantCount: 1,
          requireCompleteInputs: false,
          promptOverride: '',
        });
        return;
      }

      const productDataUrl = productImage.dataUrl;
      const analyzeProvider = getTelegramWizardAnalyzeProvider();
      const analyzed = analyzeProvider === 'openai'
        ? await analyzeReferenceImageWithAi(productDataUrl)
        : await analyzeReferenceImageWithGemini(productDataUrl);
      const aiSuggestions = mapAnalyzeResultToWizardSuggestions(analyzed);
      const aiOptionSuggestions = {};
      const autoFilledDraft = buildSimpleModeAutoDraft({
        draft: {
          ...draft,
          reference_image_url: resolvedProductUrl || String(draft.reference_image_url || ''),
        },
        aiSuggestions,
        aiOptionSuggestions,
        analyzed,
        analyzeProvider,
      });
      const nextDraft = {
        ...autoFilledDraft,
        wizard_mode: 'simple',
        simple_reference_enabled: includeReferenceImage,
        status: 'ready_for_generation',
        updated_at: new Date().toISOString(),
      };

      await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_READY, nextDraft);

      await queueWizardDraftGeneration({
        ctx,
        dbUser,
        telegramId,
        chatId,
        draft: nextDraft,
        variantCount: TELEGRAM_GENERATION_VARIANT_COUNT,
        requireCompleteInputs: false,
      });
    } catch (error) {
      console.error('Telegram Simple mode failed:', error.message);
      await ctx.reply(`Simple mode failed: ${error.message || 'Unexpected error'}`);
    }
  };

  const handleSimpleModeCommand = async (ctx) => {
    const telegramId = toTelegramId(ctx);
    const chatId = String(ctx?.chat?.id || telegramId || '').trim();
    const dbUser = ctx.state.dbUser;
    if (!telegramId || !dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }

    const botState = normalizeBotState(dbUser.bot_state);
    if (botState !== BOT_STATE_WIZARD_MODE_SELECT) {
      await ctx.reply('Upload your PNG first, then choose mode.', buildTelegramMainMenuKeyboardForCtx(ctx));
      return;
    }

    const draft = getUserDraft(dbUser);
    if (!draft.reference_image_url) {
      await ctx.reply('Please send your background-removed PNG as a Document/File first.');
      return;
    }

    await runSimpleModeGeneration({
      ctx,
      dbUser,
      telegramId,
      chatId,
      draft,
      includeReferenceImage: false,
    });
  };

  const handleNewCommand = async (ctx) => {
    await handleTelegramSignIn(ctx);
  };

  const handleCancelCommand = async (ctx) => {
    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.reply('No active session found. Please run /start first.');
      return;
    }
    await ctx.reply('\u{23F9}\u{FE0F} Cancel requested. Stopping your active wizard/generation...');
    let cancelledJobs = 0;
    try {
      cancelledJobs = await cancelActiveTelegramJobsForUser(dbUser.id, 'Cancelled from /cancel');
    } catch (error) {
      console.warn('Failed to cancel active jobs from /cancel:', error.message);
    }
    await clearUserWizardState(dbUser.id, BOT_STATE_IDLE);
    await ctx.reply(
      cancelledJobs > 0
        ? `\u{2705} Wizard canceled. ${cancelledJobs} active generation request(s) were canceled.`
        : '\u{2705} Wizard canceled.',
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );
  };

  const handleGenerateCommand = async (ctx) => {
    const telegramId = toTelegramId(ctx);
    const chatId = String(ctx?.chat?.id || telegramId || '').trim();
    const dbUser = ctx.state.dbUser;
    if (!telegramId || !dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }
    const botState = normalizeBotState(dbUser.bot_state);
    if (botState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
      await ctx.reply('Please complete sign-in by sharing your email first.');
      return;
    }
    if (botState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
      const verificationRecord = getEmailVerificationRecord(dbUser);
      await sendEmailVerificationPrompt(ctx, verificationRecord?.pendingEmail || dbUser.email || '');
      return;
    }
    if (botState === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
      await sendPhonePrompt(ctx);
      return;
    }
    if (botState === BOT_STATE_AWAITING_PLAN_SELECTION) {
      await sendPlanSelectionPrompt(ctx, dbUser, '\u{2705} Registration Complete');
      return;
    }
    if (botState === BOT_STATE_WIZARD_MODE_SELECT) {
      await ctx.reply('Choose a mode first: Simple or Advance.', buildWizardModeSelectionKeyboard());
      return;
    }
    if (botState === BOT_STATE_SIMPLE_REFERENCE_DECISION) {
      await ctx.reply(
        `Please choose: ${TELEGRAM_MENU_LABELS.yesReference} or ${TELEGRAM_MENU_LABELS.noReference}.`,
        buildSimpleReferenceDecisionKeyboard()
      );
      return;
    }
    if (botState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE) {
      await ctx.reply('Please upload your reference image first, then generation will start automatically.');
      return;
    }
    const draft = getUserDraft(dbUser);
    const variantCount = draft?.simple_reference_enabled ? 1 : TELEGRAM_GENERATION_VARIANT_COUNT;
    const isSimpleMode = String(draft?.wizard_mode || '').trim().toLowerCase() === 'simple';
    const shouldForcePromptlessSimpleReference = Boolean(draft?.simple_reference_enabled);
    try {
      await queueWizardDraftGeneration({
        ctx,
        dbUser,
        telegramId,
        chatId,
        draft,
        variantCount,
        requireCompleteInputs: !isSimpleMode,
        promptOverride: shouldForcePromptlessSimpleReference ? '' : null,
      });
    } catch (error) {
      console.error('Wizard generation failed:', error.message);
      await ctx.reply(`Generation failed: ${getTelegramFriendlyGenerationError(error)}`);
    }
  };

  const handleBuyCommand = async (ctx) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return;
    }
    const dbUser = ctx.state.dbUser;
    if (dbUser && normalizeBotState(dbUser.bot_state) === BOT_STATE_AWAITING_PLAN_SELECTION) {
      await sendPlanSelectionPrompt(ctx, dbUser, '\u{2705} Registration Complete');
      return;
    }
    const buttonRows = await buildTelegramTopupButtonRows(telegramId);
    if (!buttonRows.length) {
      await ctx.reply(
        'Payment is not available in bot yet.\nConfigure Stripe keys and callback/public server URL, then restart the server.'
      );
      return;
    }
    await ctx.reply(
      '\u{1F4B0} Select a top-up package to continue:',
      Markup.inlineKeyboard(buttonRows)
    );
  };

  const handleCreditsCommand = async (ctx) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return;
    }
    const userResult = await pool.query(
      `
        SELECT username, credits, role, plan_tier, daily_credit_quota
        FROM users
        WHERE telegram_id = $1::bigint
        LIMIT 1
      `,
      [telegramId]
    );
    if (!userResult.rowCount) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }
    const user = userResult.rows[0];
    const username = String(user.username || 'user');
    const creditsBalance = Math.max(0, Math.floor(Number(user.credits || 0)));
    const hasUnlimited = isUsageLimitExemptUser(user);
    const planTier = normalizePlanTier(user.plan_tier);
    const plan = getPlanConfig(planTier);
    const quotaRaw = Number(user.daily_credit_quota);
    const quota = Number.isFinite(quotaRaw) && quotaRaw > 0
      ? Math.floor(quotaRaw)
      : Math.max(1, Math.floor(Number(plan.monthlyCredits || 0)));

    if (hasUnlimited) {
      const progressBar = buildTelegramUsageProgressBar(0);
      await ctx.reply(
        [
          '\u{1F4B3} Wallet Status',
          `\u{1F464} Account: ${username}`,
          '\u{1F451} Plan: Admin (Unlimited)',
          `\u{1F4B0} Credits: ${creditsBalance}`,
          `${progressBar} (0% used)`,
        ].join('\n'),
        buildTelegramMainMenuKeyboardForCtx(ctx)
      );
      return;
    }

    const usedCredits = Math.max(0, quota - Math.min(quota, creditsBalance));
    const usedPercent = quota > 0 ? Math.round((usedCredits / quota) * 100) : 0;
    const progressBar = buildTelegramUsageProgressBar(usedPercent);
    const extraCredits = Math.max(0, creditsBalance - quota);

    await ctx.reply(
      [
        '\u{1F4B3} Wallet Status',
        `\u{1F464} Account: ${username}`,
        `\u{1F4E6} Plan: ${plan.name}`,
        `\u{1F4B0} Credits: ${creditsBalance}/${quota}`,
        extraCredits > 0 ? `\u{1F381} Top-up Extra: +${extraCredits}` : '',
        `${progressBar} (${usedPercent}% used)`,
      ].filter(Boolean).join('\n'),
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );
  };

  const handleMenuCommand = async (ctx) => {
    await ctx.reply(
      [
        '\u{1F4CB} Command Menu',
        `/start - Start or reconnect account`,
        `${TELEGRAM_MENU_LABELS.signin} - Sign in to your account`,
        `${TELEGRAM_MENU_LABELS.shareContact} - Share phone during sign-in`,
        `${TELEGRAM_MENU_LABELS.new} - Start guided generation wizard`,
        `${TELEGRAM_MENU_LABELS.simpleMode} - Auto fill + auto generate (after PNG upload)`,
        `${TELEGRAM_MENU_LABELS.advanceMode} - Manual guided wizard mode (after PNG upload)`,
        `${TELEGRAM_MENU_LABELS.fillAi} - AI suggestions from your uploaded image`,
        `${TELEGRAM_MENU_LABELS.generate} - Generate from wizard inputs`,
        `${TELEGRAM_MENU_LABELS.cancel} - Cancel current wizard`,
        `${TELEGRAM_MENU_LABELS.credits} - Check credits`,
        `${TELEGRAM_MENU_LABELS.buy} - Buy credits`,
        `${TELEGRAM_MENU_LABELS.logout} - Logout from Telegram bot`,
        `${TELEGRAM_MENU_LABELS.help} - Usage guide`,
      ].join('\n'),
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );
  };

  const handleLogoutCommand = async (ctx) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return;
    }

    const current = await pool.query(
      `
        SELECT *
        FROM users
        WHERE telegram_id = $1::bigint
        LIMIT 1
      `,
      [telegramId]
    );
    if (!current.rowCount) {
      await ctx.reply('No active Telegram session found. Use /start to sign in.');
      return;
    }

    const dbUser = current.rows[0];
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `
          UPDATE user_sessions
          SET revoked_at = NOW()
          WHERE user_id = $1
            AND user_agent = 'telegram-bot'
            AND revoked_at IS NULL
        `,
        [dbUser.id]
      );

      if (dbUser.email) {
        await client.query(
          `
            UPDATE users
            SET telegram_id = NULL,
                bot_state = $2,
                bot_data = COALESCE(bot_data, '{}'::jsonb) - 'telegram_session',
                updated_at = NOW()
            WHERE id = $1
          `,
          [dbUser.id, BOT_STATE_AWAITING_REGISTRATION_EMAIL]
        );
      } else {
        await client.query(
          `
            DELETE FROM users
            WHERE id = $1
          `,
          [dbUser.id]
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    await ctx.reply('\u{2705} You have been logged out. Use /start to sign in again.', Markup.removeKeyboard());
  };

  const handleHelpCommand = async (ctx) => {
    await ctx.reply(
      [
        '1) Run /start, then share your email when prompted.',
        '2) Enter the verification code sent to your inbox, then tap "Share Contact".',
        '3) Use /new to start the guided setup.',
        '4) Upload your background-removed PNG as a Document/File.',
        '5) Choose mode: Simple (auto analyze + auto generate) or Advance (guided wizard).',
        '6) In Simple mode, choose whether to add a reference image (Yes/No).',
        '7) In Advance mode, tap "Fill Up with AI" for editable suggestions if needed.',
        '8) Complete Advance wizard fields, then run /generate.',
        '9) Each generated image uses 1 credit.',
        '10) Use /buy when your credits are low.',
        '11) Use /logout to unlink your Telegram session.',
      ].join('\n'),
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );
  };

  bot.command('new', handleNewCommand);
  bot.command('fill', handleFillUpWithAiCommand);
  bot.command('cancel', handleCancelCommand);
  bot.command('generate', handleGenerateCommand);
  bot.command('buy', handleBuyCommand);
  bot.command('credits', handleCreditsCommand);
  bot.command('menu', handleMenuCommand);
  bot.command('logout', handleLogoutCommand);
  bot.command('help', handleHelpCommand);

  bot.hears(TELEGRAM_MENU_LABELS.start, handleTelegramSignIn);
  bot.hears(TELEGRAM_MENU_LABELS.signin, handleTelegramSignIn);
  bot.hears(TELEGRAM_MENU_LABELS.new, handleNewCommand);
  bot.hears(TELEGRAM_MENU_LABELS.fillAi, handleFillUpWithAiCommand);
  bot.hears(TELEGRAM_MENU_LABELS.generate, handleGenerateCommand);
  bot.hears(TELEGRAM_MENU_LABELS.regenerate, handleGenerateCommand);
  bot.hears(TELEGRAM_MENU_LABELS.credits, handleCreditsCommand);
  bot.hears(TELEGRAM_MENU_LABELS.buy, handleBuyCommand);
  bot.hears(TELEGRAM_MENU_LABELS.help, handleHelpCommand);
  bot.hears(TELEGRAM_MENU_LABELS.logout, handleLogoutCommand);
  bot.hears(TELEGRAM_MENU_LABELS.menu, handleMenuCommand);
  bot.hears(TELEGRAM_MENU_LABELS.cancel, handleCancelCommand);

  bot.action(TELEGRAM_PLAN_FREE_CALLBACK_DATA, async (ctx) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      await ctx.answerCbQuery('Session not found.');
      return;
    }

    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.answerCbQuery('Please run /start first.');
      await ctx.reply('Please run /start first to begin.');
      return;
    }
    if (normalizeBotState(dbUser.bot_state) !== BOT_STATE_AWAITING_PLAN_SELECTION) {
      await ctx.answerCbQuery('Plan selection is already complete.');
      return;
    }

    let activeUser = dbUser;
    try {
      const updatedUser = await activateTelegramFreePlan(dbUser.id);
      if (updatedUser) {
        activeUser = updatedUser;
      }
    } catch (error) {
      console.warn('Failed to activate free plan from Telegram callback:', error.message);
    }

    await ctx.answerCbQuery('It\'s a free plan.');
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (error) {
      // ignore: message may be already edited or not editable
    }
    await ctx.reply('It\'s a free plan.');
    await sendAccountReadyMessage(ctx, activeUser, '\u{2705} Registration Complete');
  });

  bot.on('contact', async (ctx) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return;
    }

    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }

    const botState = normalizeBotState(dbUser.bot_state);
    if (botState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
      await sendEmailPrompt(ctx);
      return;
    }
    if (botState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
      const verificationRecord = getEmailVerificationRecord(dbUser);
      await sendEmailVerificationPrompt(ctx, verificationRecord?.pendingEmail || dbUser.email || '');
      return;
    }

    const contact = ctx.message?.contact;
    const contactPhone = normalizePhoneNumber(contact?.phone_number || '');
    const contactUserId = String(contact?.user_id || '').trim();
    if (!contactPhone || !isValidPhoneNumber(contactPhone)) {
      await ctx.reply('The phone number looks invalid. Please tap "Share Contact" again.');
      return;
    }
    if (contactUserId && contactUserId !== telegramId) {
      await ctx.reply('Please share your own Telegram contact (not someone else\'s).');
      return;
    }

    const mergedUserForState = {
      ...dbUser,
      bot_data: {
        ...(dbUser?.bot_data && typeof dbUser.bot_data === 'object' ? dbUser.bot_data : {}),
        phone: contactPhone,
      },
    };
    const nextState = isRegistrationPendingState(botState)
      ? getRegistrationStateForUser(mergedUserForState)
      : botState;
    const collectedAt = new Date().toISOString();
    const updatedResult = await pool.query(
      `
        UPDATE users
        SET bot_state = $2,
            is_active = TRUE,
            bot_data = jsonb_set(
              jsonb_set(
                jsonb_set(COALESCE(bot_data, '{}'::jsonb), '{phone}', to_jsonb($3::text), true),
                '{phone_collected}',
                'true'::jsonb,
                true
              ),
              '{phone_collected_at}',
              to_jsonb($4::text),
              true
            ),
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [dbUser.id, nextState, contactPhone, collectedAt]
    );
    const updatedUser = updatedResult.rows[0] || null;
    if (!updatedUser) {
      await ctx.reply('Session not found. Please run /start again.');
      return;
    }

    if (isRegistrationPendingState(botState)) {
      const updatedState = normalizeBotState(updatedUser.bot_state);
      if (updatedState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
        await sendEmailPrompt(ctx);
        return;
      }
      if (updatedState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
        const verificationRecord = getEmailVerificationRecord(updatedUser);
        await sendEmailVerificationPrompt(ctx, verificationRecord?.pendingEmail || updatedUser.email || '');
        return;
      }
      if (updatedState === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
        await sendPhonePrompt(ctx);
        return;
      }
      await sendPostRegistrationPlanPromptOrReady(ctx, updatedUser, '\u{2705} Registration Complete');
      return;
    }

    await ctx.reply('\u{2705} Phone number updated successfully.', buildTelegramMainMenuKeyboardForCtx(ctx));
  });

  bot.on('text', async (ctx) => {
    const telegramId = toTelegramId(ctx);
    const messageText = String(ctx.message?.text || '').trim();
    if (!telegramId || !messageText || messageText.startsWith('/')) {
      return;
    }

    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }

    const botState = normalizeBotState(dbUser.bot_state);
    const buildVerifiedEmailBotData = (sourceBotData, verifiedEmail, verifiedAt) => {
      const nextBotData = sourceBotData && typeof sourceBotData === 'object'
        ? { ...sourceBotData }
        : {};
      delete nextBotData.email_verification;
      nextBotData.email_collected = true;
      nextBotData.email_collected_at = verifiedAt;
      nextBotData.email_verified = true;
      nextBotData.email_verified_at = verifiedAt;
      nextBotData.email_verified_email = String(verifiedEmail || '').toLowerCase();
      nextBotData.onboarding = 'phone';
      return nextBotData;
    };

    if (botState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
      if (!smtpReady) {
        await ctx.reply('Email verification is currently unavailable. Please contact support.');
        return;
      }
      if (!isValidEmail(messageText)) {
        await ctx.reply('That email format looks invalid. Please send a valid email.');
        return;
      }

      const normalizedEmail = messageText.toLowerCase();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const currentUserResult = await client.query(
          `
            SELECT *
            FROM users
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [dbUser.id]
        );
        if (!currentUserResult.rowCount) {
          await client.query('ROLLBACK');
          await ctx.reply('Session not found. Please run /start again.');
          return;
        }
        const currentUser = currentUserResult.rows[0];

        const existingByEmail = await client.query(
          `
            SELECT *
            FROM users
            WHERE LOWER(email) = LOWER($1)
              AND id <> $2
            LIMIT 1
            FOR UPDATE
          `,
          [normalizedEmail, currentUser.id]
        );

        if (existingByEmail.rowCount) {
          const matchedUser = existingByEmail.rows[0];
          if (matchedUser.telegram_id && String(matchedUser.telegram_id) !== telegramId) {
            await client.query('ROLLBACK');
            await ctx.reply('This email is already linked to another Telegram account.');
            return;
          }
        }

        const fallbackUsername = await findAvailableUsername(
          client,
          buildTelegramUsernameCandidates(ctx, telegramId),
          `tg_${telegramId}`
        );
        const verificationCode = generateEmailVerificationCode();
        const verificationExpiresAt = new Date(Date.now() + (EMAIL_VERIFICATION_EXPIRY_MINUTES * 60 * 1000)).toISOString();
        const verificationRecord = {
          pending_email: normalizedEmail,
          code_hash: hashEmailVerificationCode({
            code: verificationCode,
            email: normalizedEmail,
            userId: currentUser.id,
          }),
          expires_at: verificationExpiresAt,
          attempts: 0,
          requested_at: new Date().toISOString(),
          target_user_id: existingByEmail.rowCount ? existingByEmail.rows[0].id : null,
        };
        const nextBotData = {
          ...getUserBotDataObject(currentUser),
          onboarding: 'email_verification',
          email_verification_required: true,
          email_verification: verificationRecord,
        };

        await sendEmailVerificationCode({
          email: normalizedEmail,
          code: verificationCode,
        });

        const createdOrUpdatedResult = await client.query(
          `
            UPDATE users
            SET username = COALESCE(NULLIF(username, ''), $1),
                bot_state = $2,
                role = 'member',
                is_active = TRUE,
                credits = GREATEST(COALESCE(credits, 0), 5),
                bot_data = $3::jsonb,
                created_at = COALESCE(created_at, NOW()),
                updated_at = NOW()
            WHERE id = $4
            RETURNING *
          `,
          [fallbackUsername, BOT_STATE_AWAITING_EMAIL_VERIFICATION, JSON.stringify(nextBotData), currentUser.id]
        );
        const createdOrUpdatedUser = createdOrUpdatedResult.rows[0];
        await createTelegramSessionTx(client, createdOrUpdatedUser.id, telegramId);
        await client.query('COMMIT');

        scheduleTelegramProfileSync(createdOrUpdatedUser.id, telegramId, ctx.from);
        await sendEmailVerificationPrompt(ctx, normalizedEmail);
      } catch (error) {
        await client.query('ROLLBACK');
        if (error?.code === '23505') {
          await ctx.reply('This email is already in use. Please send a different email.');
          return;
        }
        console.error('Email verification send failed:', error.message);
        await ctx.reply('We could not send the verification code right now. Please try again.');
        return;
      } finally {
        client.release();
      }

      return;
    }

    if (botState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
      if (!smtpReady) {
        await ctx.reply('Email verification is currently unavailable. Please contact support.');
        return;
      }

      const loweredText = String(messageText || '').trim().toLowerCase();
      if (isValidEmail(messageText)) {
        await pool.query(
          `
            UPDATE users
            SET bot_state = $2,
                bot_data = COALESCE(bot_data, '{}'::jsonb) - 'email_verification',
                updated_at = NOW()
            WHERE id = $1
          `,
          [dbUser.id, BOT_STATE_AWAITING_REGISTRATION_EMAIL]
        );
        await ctx.reply('Email updated. Please send the new email to continue.');
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const currentUserResult = await client.query(
          `
            SELECT *
            FROM users
            WHERE id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [dbUser.id]
        );
        if (!currentUserResult.rowCount) {
          await client.query('ROLLBACK');
          await ctx.reply('Session not found. Please run /start again.');
          return;
        }
        const currentUser = currentUserResult.rows[0];
        const currentBotData = getUserBotDataObject(currentUser);
        const verificationRecord = getEmailVerificationRecord(currentUser);
        if (!isEmailVerificationRecordValid(verificationRecord)) {
          const resetBotData = { ...currentBotData };
          delete resetBotData.email_verification;
          await client.query(
            `
              UPDATE users
              SET bot_state = $2,
                  bot_data = $3::jsonb,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [currentUser.id, BOT_STATE_AWAITING_REGISTRATION_EMAIL, JSON.stringify(resetBotData)]
          );
          await client.query('COMMIT');
          await ctx.reply('Verification code expired. Please send your email again to request a new code.');
          return;
        }

        if (['resend', 'resend code', 'send again'].includes(loweredText)) {
          const newCode = generateEmailVerificationCode();
          const refreshedRecord = {
            ...verificationRecord,
            code_hash: hashEmailVerificationCode({
              code: newCode,
              email: verificationRecord.pendingEmail,
              userId: currentUser.id,
            }),
            expires_at: new Date(Date.now() + (EMAIL_VERIFICATION_EXPIRY_MINUTES * 60 * 1000)).toISOString(),
            attempts: 0,
            requested_at: new Date().toISOString(),
          };
          const nextBotData = {
            ...currentBotData,
            email_verification: {
              pending_email: refreshedRecord.pendingEmail,
              code_hash: refreshedRecord.code_hash,
              expires_at: refreshedRecord.expires_at,
              attempts: refreshedRecord.attempts,
              requested_at: refreshedRecord.requested_at,
              target_user_id: refreshedRecord.targetUserId || null,
            },
          };

          await sendEmailVerificationCode({
            email: refreshedRecord.pendingEmail,
            code: newCode,
          });

          await client.query(
            `
              UPDATE users
              SET bot_state = $2,
                  bot_data = $3::jsonb,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [currentUser.id, BOT_STATE_AWAITING_EMAIL_VERIFICATION, JSON.stringify(nextBotData)]
          );
          await client.query('COMMIT');
          await sendEmailVerificationPrompt(ctx, refreshedRecord.pendingEmail);
          return;
        }

        const submittedCode = String(messageText || '').replace(/\s+/g, '');
        if (!new RegExp(`^\\d{${EMAIL_VERIFICATION_CODE_LENGTH}}$`).test(submittedCode)) {
          await client.query('ROLLBACK');
          await ctx.reply(
            `Please enter a valid ${EMAIL_VERIFICATION_CODE_LENGTH}-digit code, or type "resend".`
          );
          return;
        }

        const submittedCodeHash = hashEmailVerificationCode({
          code: submittedCode,
          email: verificationRecord.pendingEmail,
          userId: currentUser.id,
        });

        if (submittedCodeHash !== verificationRecord.codeHash) {
          const nextAttempts = verificationRecord.attempts + 1;
          if (nextAttempts >= EMAIL_VERIFICATION_MAX_ATTEMPTS) {
            const resetBotData = { ...currentBotData };
            delete resetBotData.email_verification;
            await client.query(
              `
                UPDATE users
                SET bot_state = $2,
                    bot_data = $3::jsonb,
                    updated_at = NOW()
                WHERE id = $1
              `,
              [currentUser.id, BOT_STATE_AWAITING_REGISTRATION_EMAIL, JSON.stringify(resetBotData)]
            );
            await client.query('COMMIT');
            await ctx.reply('Too many incorrect attempts. Please send your email again.');
            return;
          }

          const nextBotData = {
            ...currentBotData,
            email_verification: {
              pending_email: verificationRecord.pendingEmail,
              code_hash: verificationRecord.codeHash,
              expires_at: verificationRecord.expiresAt,
              attempts: nextAttempts,
              requested_at: new Date().toISOString(),
              target_user_id: verificationRecord.targetUserId || null,
            },
          };
          await client.query(
            `
              UPDATE users
              SET bot_data = $2::jsonb,
                  updated_at = NOW()
              WHERE id = $1
            `,
            [currentUser.id, JSON.stringify(nextBotData)]
          );
          await client.query('COMMIT');
          await ctx.reply(`That code is incorrect. Try again or type "resend".`);
          return;
        }

        const verifiedAt = new Date().toISOString();
        if (verificationRecord.targetUserId && verificationRecord.targetUserId !== currentUser.id) {
          const targetUserResult = await client.query(
            `
              SELECT *
              FROM users
              WHERE id = $1
              LIMIT 1
              FOR UPDATE
            `,
            [verificationRecord.targetUserId]
          );
          if (!targetUserResult.rowCount) {
            const resetBotData = { ...currentBotData };
            delete resetBotData.email_verification;
            await client.query(
              `
                UPDATE users
                SET bot_state = $2,
                    bot_data = $3::jsonb,
                    updated_at = NOW()
                WHERE id = $1
              `,
              [currentUser.id, BOT_STATE_AWAITING_REGISTRATION_EMAIL, JSON.stringify(resetBotData)]
            );
            await client.query('COMMIT');
            await ctx.reply('Account match changed. Please send your email again to continue.');
            return;
          }

          const targetUser = targetUserResult.rows[0];
          if (targetUser.telegram_id && String(targetUser.telegram_id) !== telegramId) {
            const resetBotData = { ...currentBotData };
            delete resetBotData.email_verification;
            await client.query(
              `
                UPDATE users
                SET bot_state = $2,
                    bot_data = $3::jsonb,
                    updated_at = NOW()
                WHERE id = $1
              `,
              [currentUser.id, BOT_STATE_AWAITING_REGISTRATION_EMAIL, JSON.stringify(resetBotData)]
            );
            await client.query('COMMIT');
            await ctx.reply('This email is already linked to another Telegram account.');
            return;
          }

          if (currentUser.id !== targetUser.id) {
            // Free the unique telegram_id from the temporary onboarding row first.
            await client.query(
              `
                UPDATE users
                SET telegram_id = NULL,
                    updated_at = NOW()
                WHERE id = $1
              `,
              [currentUser.id]
            );
          }

          const linkedBotData = buildVerifiedEmailBotData(
            getUserBotDataObject(targetUser),
            verificationRecord.pendingEmail,
            verifiedAt
          );
          const linkedState = getRegistrationStateForUser({
            ...targetUser,
            email: verificationRecord.pendingEmail,
            bot_data: linkedBotData,
          });
          const linkedResult = await client.query(
            `
              UPDATE users
              SET telegram_id = $1::bigint,
                  email = $2,
                  bot_state = $3,
                  is_active = TRUE,
                  role = 'member',
                  credits = GREATEST(COALESCE(credits, 0), 5),
                  bot_data = $4::jsonb,
                  updated_at = NOW()
              WHERE id = $5
              RETURNING *
            `,
            [
              telegramId,
              verificationRecord.pendingEmail,
              linkedState,
              JSON.stringify(linkedBotData),
              targetUser.id,
            ]
          );
          const linkedUser = linkedResult.rows[0];

          if (currentUser.id !== linkedUser.id) {
            await client.query(
              `
                UPDATE users
                SET telegram_id = NULL,
                    updated_at = NOW()
                WHERE id = $1
              `,
              [currentUser.id]
            );
            await client.query(
              `
                DELETE FROM users
                WHERE id = $1
              `,
              [currentUser.id]
            );
          }

          await createTelegramSessionTx(client, linkedUser.id, telegramId);
          await client.query('COMMIT');

          scheduleTelegramProfileSync(linkedUser.id, telegramId, ctx.from);

          const linkedStateNormalized = normalizeBotState(linkedUser.bot_state);
          if (linkedStateNormalized === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
            await sendEmailPrompt(ctx);
            return;
          }
          if (linkedStateNormalized === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
            const linkedVerificationRecord = getEmailVerificationRecord(linkedUser);
            await sendEmailVerificationPrompt(ctx, linkedVerificationRecord?.pendingEmail || linkedUser.email || '');
            return;
          }
          if (linkedStateNormalized === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
            await sendPhonePrompt(ctx);
            return;
          }

          await sendPostRegistrationPlanPromptOrReady(ctx, linkedUser, '\u{2705} Account Matched');
          return;
        }

        const fallbackUsername = await findAvailableUsername(
          client,
          buildTelegramUsernameCandidates(ctx, telegramId),
          `tg_${telegramId}`
        );
        const verifiedBotData = buildVerifiedEmailBotData(
          currentBotData,
          verificationRecord.pendingEmail,
          verifiedAt
        );
        const nextState = getRegistrationStateForUser({
          ...currentUser,
          email: verificationRecord.pendingEmail,
          bot_data: verifiedBotData,
        });
        const updatedResult = await client.query(
          `
            UPDATE users
            SET username = COALESCE(NULLIF(username, ''), $1),
                email = $2,
                bot_state = $3,
                role = 'member',
                is_active = TRUE,
                credits = GREATEST(COALESCE(credits, 0), 5),
                bot_data = $4::jsonb,
                updated_at = NOW()
            WHERE id = $5
            RETURNING *
          `,
          [
            fallbackUsername,
            verificationRecord.pendingEmail,
            nextState,
            JSON.stringify(verifiedBotData),
            currentUser.id,
          ]
        );
        const updatedUser = updatedResult.rows[0];
        await createTelegramSessionTx(client, updatedUser.id, telegramId);
        await client.query('COMMIT');

        scheduleTelegramProfileSync(updatedUser.id, telegramId, ctx.from);

        if (normalizeBotState(updatedUser.bot_state) === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
          await sendPhonePrompt(ctx);
          return;
        }

        await sendPostRegistrationPlanPromptOrReady(ctx, updatedUser, '\u{2705} Registration Complete');
      } catch (error) {
        await client.query('ROLLBACK');
        if (error?.code === '23505') {
          const detail = String(error?.detail || '').toLowerCase();
          if (detail.includes('telegram_id')) {
            await ctx.reply('This email is already linked to another Telegram account.');
            return;
          }
          if (detail.includes('email')) {
            await ctx.reply('This email is already in use. Please send a different email.');
            return;
          }
        }
        console.error('Email verification finalize failed:', error.message);
        await ctx.reply('We could not verify the code right now. Please try again.');
      } finally {
        client.release();
      }
      return;
    }

    if (botState === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
      await ctx.reply(
        '\u{1F4F1} Tap "Share Contact" to continue. This securely links your Telegram phone number to your account.',
        buildTelegramPhoneRequestKeyboard(dbUser)
      );
      return;
    }

    if (botState === BOT_STATE_AWAITING_PLAN_SELECTION) {
      const lowered = String(messageText || '').trim().toLowerCase();
      if (lowered.includes('free')) {
        const updatedUser = await activateTelegramFreePlan(dbUser.id);
        await ctx.reply('It\'s a free plan.');
        await sendAccountReadyMessage(ctx, updatedUser || dbUser, '\u{2705} Registration Complete');
        return;
      }

      let requestedPlanTier = '';
      if (lowered.includes('basic')) {
        requestedPlanTier = 'basic';
      } else if (lowered.includes('pro')) {
        requestedPlanTier = 'pro';
      }

      if (requestedPlanTier) {
        const checkoutUrl = await createTelegramPlanCheckoutUrl({
          telegramId,
          user: dbUser,
          planTier: requestedPlanTier,
        });
        const selectedPlan = getPlanConfig(requestedPlanTier);
        if (!checkoutUrl) {
          await ctx.reply('Stripe checkout is unavailable right now. Please choose Free or try again later.');
          return;
        }
        await ctx.reply(
          `\u{1F4B3} Continue with Stripe to activate ${selectedPlan.name}.`,
          Markup.inlineKeyboard([
            [Markup.button.url(`Pay for ${selectedPlan.name}`, checkoutUrl)],
          ])
        );
        return;
      }

      await sendPlanSelectionPrompt(ctx, dbUser, '\u{2705} Registration Complete');
      return;
    }

    if (botState === BOT_STATE_WIZARD_MODE_SELECT) {
      const lowered = String(messageText || '').trim().toLowerCase();
      if (messageText === TELEGRAM_MENU_LABELS.cancel || lowered === 'cancel') {
        await handleCancelCommand(ctx);
        return;
      }
      if (messageText === TELEGRAM_MENU_LABELS.simpleMode || /^simple\b/.test(lowered)) {
        await handleSimpleModeCommand(ctx);
        return;
      }
      if (
        messageText === TELEGRAM_MENU_LABELS.advanceMode ||
        /^advance(?:d)?\b/.test(lowered)
      ) {
        await handleAdvanceModeCommand(ctx);
        return;
      }
      await ctx.reply(
        `Please choose one mode: ${TELEGRAM_MENU_LABELS.simpleMode} or ${TELEGRAM_MENU_LABELS.advanceMode}.`,
        buildWizardModeSelectionKeyboard()
      );
      return;
    }

    if (botState === BOT_STATE_SIMPLE_REFERENCE_DECISION) {
      const lowered = String(messageText || '').trim().toLowerCase();
      const draft = getUserDraft(dbUser);
      const isYes =
        messageText === TELEGRAM_MENU_LABELS.yesReference ||
        ['yes', 'y', 'add reference', 'reference', 'lagbe', 'yes reference'].includes(lowered);
      const isNo =
        messageText === TELEGRAM_MENU_LABELS.noReference ||
        ['no', 'n', 'skip', 'continue', 'no reference', 'na'].includes(lowered);

      if (isYes) {
        const nextDraft = {
          ...draft,
          wizard_mode: 'simple',
          simple_reference_enabled: true,
          status: 'awaiting_simple_reference_image',
          updated_at: new Date().toISOString(),
        };
        await setUserWizardState(dbUser.id, BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE, nextDraft);
        await ctx.reply(
          '\u{1F4CE} Send your reference image now as Document/File (or photo). We will run Reference-img-pipeline-1 after upload.',
          Markup.keyboard([[TELEGRAM_MENU_LABELS.cancel]]).resize()
        );
        return;
      }

      if (isNo) {
        const nextDraft = {
          ...draft,
          simple_reference_enabled: false,
          simple_reference_image_url: '',
          simple_reference_telegram_file_id: '',
          simple_reference_mime_type: '',
          simple_reference_source_kind: '',
          simple_reference_file_name: '',
          status: 'collecting',
          updated_at: new Date().toISOString(),
        };
        await promptWizardModeSelection({
          ctx,
          dbUser,
          draft: nextDraft,
          preferredAdvanceState: sanitizePendingAdvanceState(
            nextDraft?.pending_advance_state || getWizardFirstInputState()
          ),
        });
        return;
      }

      await ctx.reply(
        `Please choose: ${TELEGRAM_MENU_LABELS.yesReference} or ${TELEGRAM_MENU_LABELS.noReference}.`,
        buildSimpleReferenceDecisionKeyboard()
      );
      return;
    }

    if (botState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE) {
      await ctx.reply(
        '\u{1F4CE} Please upload your reference image now as Document/File (or photo), or tap cancel.',
        Markup.keyboard([[TELEGRAM_MENU_LABELS.cancel]]).resize()
      );
      return;
    }

    if (botState === BOT_STATE_WIZARD_WAITING_REFERENCE) {
      await ctx.reply('\u{1F4CE} Step 1/13: Send your background-removed PNG as a Document/File first.');
      return;
    }

    if (isWizardInputState(botState)) {
      const step = getWizardStepByState(botState);
      if (!step) {
        await ctx.reply('Wizard step is invalid. Use /new to restart.');
        return;
      }

      const currentDraft = getUserDraft(dbUser);
      const valueInput = messageText;
      if (step.key === 'brand_logo_file') {
        const lowered = String(valueInput || '').toLowerCase();
        if (
          lowered.includes('skip') ||
          ['none', 'no', 'n/a', '-'].includes(lowered.trim())
        ) {
          const nextDraft = {
            ...currentDraft,
            brand_logo_file: '',
            brand_logo_telegram_file_id: '',
            brand_logo_mime_type: '',
            brand_logo_source_kind: '',
            brand_logo_file_name: '',
            brand_logo_has_transparency: false,
            updated_at: new Date().toISOString(),
          };
          await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_READY, nextDraft);
          await ctx.reply(
            `\u{2705} Wizard completed.\n${buildWizardPromptSummary(nextDraft)}\n\nUse /generate to create images.`,
            Markup.keyboard(
              [[TELEGRAM_MENU_LABELS.generate, TELEGRAM_MENU_LABELS.new], [TELEGRAM_MENU_LABELS.cancel]]
            ).resize()
          );
          return;
        }

        await ctx.reply(
          'Please send your brand logo as a PNG Document/File, or type skip.',
          buildWizardReplyMarkup(step, currentDraft)
        );
        return;
      }

      let value = normalizeWizardValue(valueInput);
      if (step.key === 'additional_directives') {
        value = value || normalizeAiSuggestionValue(currentDraft?.additional_directives) ||
          buildAutoAdditionalDirective(currentDraft);
      }
      if (step.key === 'cta') {
        value = normalizeCtaChoice(value, 'None') || 'None';
      }
      const nextDraft = {
        ...currentDraft,
        [step.key]: value,
        updated_at: new Date().toISOString(),
      };

      const nextState = getNextWizardStepState(step.state);
      await setUserWizardState(dbUser.id, nextState, nextDraft);

      if (nextState === BOT_STATE_WIZARD_READY) {
        await ctx.reply(
          `\u{2705} Wizard completed.\n${buildWizardPromptSummary(nextDraft)}\n\nUse /generate to create images.`,
          Markup.keyboard(
            [[TELEGRAM_MENU_LABELS.generate, TELEGRAM_MENU_LABELS.new], [TELEGRAM_MENU_LABELS.cancel]]
          ).resize()
        );
        return;
      }

      await sendWizardStepPrompt(ctx, nextState, nextDraft);
      return;
    }

    if (botState === BOT_STATE_WIZARD_READY) {
      await ctx.reply('\u{2705} Wizard is ready. Use /generate to create images, /new to restart, or /cancel.');
      return;
    }

    await ctx.reply(
      'Use /new for guided setup, then send your PNG Document/File and run /generate.',
      buildTelegramMainMenuKeyboardForCtx(ctx)
    );
  });

  const handleTelegramImageUpload = async ({
    ctx,
    fileId,
    sourceKind,
    inputMimeType = '',
    originalFileName = '',
  }) => {
    const telegramId = toTelegramId(ctx);
    if (!telegramId) {
      return;
    }

    const dbUser = ctx.state.dbUser;
    if (!dbUser) {
      await ctx.reply('Please run /start first to begin.');
      return;
    }

    const botState = normalizeBotState(dbUser.bot_state);
    if (botState === BOT_STATE_AWAITING_REGISTRATION_EMAIL) {
      await ctx.reply('Please complete sign-in first by sharing your email address.');
      return;
    }
    if (botState === BOT_STATE_AWAITING_EMAIL_VERIFICATION) {
      const verificationRecord = getEmailVerificationRecord(dbUser);
      await sendEmailVerificationPrompt(ctx, verificationRecord?.pendingEmail || dbUser.email || '');
      return;
    }
    if (botState === BOT_STATE_AWAITING_REGISTRATION_PHONE) {
      await sendPhonePrompt(ctx);
      return;
    }
    if (botState === BOT_STATE_AWAITING_PLAN_SELECTION) {
      await sendPlanSelectionPrompt(ctx, dbUser, '\u{2705} Registration Complete');
      return;
    }

    if (!isUsageLimitExemptUser(dbUser) && Number(dbUser.credits || 0) <= 0) {
      await sendBuyPrompt(ctx, telegramId);
      return;
    }

    const normalizedState = botState;
    if (normalizedState === 'WIZARD_BRAND_LOGO' && sourceKind !== 'document') {
      await ctx.reply('For brand logo, please send a PNG as a Document/File (not photo).');
      return;
    }

    try {
      const fileLink = await ctx.telegram.getFileLink(fileId);
      const imageUrl = String(fileLink);
      const referenceDataUrlRaw = await fetchRemoteImageAsDataUrl(imageUrl);
      const referenceDataUrl = await ensureImageDataUrlMime(referenceDataUrlRaw, inputMimeType || 'image/png');
      const imageInfo = await inspectImageDataUrl(referenceDataUrl);
      const resolvedMimeType = imageInfo.mimeType || inputMimeType || 'image/jpeg';
      const fileExt = getFileExtension(originalFileName);
      const isPngInput = isPngMime(resolvedMimeType) || fileExt === '.png';
      const isReferenceUploadState =
        normalizedState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE ||
        normalizedState === BOT_STATE_SIMPLE_REFERENCE_DECISION;

      if (normalizedState === 'WIZARD_BRAND_LOGO' && !isPngInput) {
        await ctx.reply('Please upload the brand logo as a PNG Document/File, or type skip.');
        return;
      }

      if ((sourceKind === 'document' || sourceKind === 'photo') && !isPngInput && !isReferenceUploadState) {
        await ctx.reply('Tip: For best results, send a background-removed PNG (Photo or Document/File).');
      } else if (sourceKind === 'photo' && !imageInfo.hasTransparentPixels && !isReferenceUploadState) {
        await ctx.reply('Tip: For better results, send PNG as a Document/File (not photo) to keep transparency.');
      }

      const referenceMode = 'edit';
      if (
        normalizedState === BOT_STATE_WIZARD_WAITING_REFERENCE ||
        normalizedState === BOT_STATE_WIZARD_MODE_SELECT ||
        normalizedState === BOT_STATE_SIMPLE_REFERENCE_DECISION ||
        normalizedState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE ||
        normalizedState === BOT_STATE_WIZARD_READY ||
        isWizardInputState(normalizedState)
      ) {
        const currentDraft = getUserDraft(dbUser);
        if (normalizedState === 'WIZARD_BRAND_LOGO') {
          const nextDraft = {
            ...currentDraft,
            brand_logo_file: imageUrl,
            brand_logo_telegram_file_id: String(fileId || '').trim(),
            brand_logo_mime_type: resolvedMimeType,
            brand_logo_source_kind: sourceKind,
            brand_logo_file_name: originalFileName || '',
            brand_logo_has_transparency: Boolean(imageInfo.hasTransparentPixels),
            updated_at: new Date().toISOString(),
          };
          await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_READY, nextDraft);
          await ctx.reply(
            `\u{2705} Logo PNG attached.\n${buildWizardPromptSummary(nextDraft)}\n\nUse /generate to create images.`,
            Markup.keyboard(
              [[TELEGRAM_MENU_LABELS.generate, TELEGRAM_MENU_LABELS.new], [TELEGRAM_MENU_LABELS.cancel]]
            ).resize()
          );
          return;
        }

        if (
          normalizedState === BOT_STATE_SIMPLE_WAITING_REFERENCE_IMAGE ||
          normalizedState === BOT_STATE_SIMPLE_REFERENCE_DECISION
        ) {
          const nextDraft = {
            ...currentDraft,
            wizard_mode: 'simple',
            simple_reference_enabled: true,
            simple_reference_image_url: imageUrl,
            simple_reference_telegram_file_id: String(fileId || '').trim(),
            simple_reference_mime_type: resolvedMimeType,
            simple_reference_source_kind: sourceKind,
            simple_reference_file_name: originalFileName || '',
            status: 'ready_for_generation',
            updated_at: new Date().toISOString(),
          };
          await setUserWizardState(dbUser.id, BOT_STATE_WIZARD_READY, nextDraft);
          await ctx.reply('\u{2705} Reference image received. Starting Reference-img-pipeline-1...');
          const liveUserResult = await pool.query(
            `
              SELECT *
              FROM users
              WHERE id = $1
              LIMIT 1
            `,
            [dbUser.id]
          );
          const liveUser = liveUserResult.rows[0] || dbUser;
          const chatId = String(ctx?.chat?.id || telegramId || '').trim();
          await runSimpleModeGeneration({
            ctx,
            dbUser: liveUser,
            telegramId,
            chatId,
            draft: nextDraft,
            includeReferenceImage: true,
          });
          return;
        }

        const nextDraft = {
          ...currentDraft,
          reference_image_url: imageUrl,
          reference_telegram_file_id: String(fileId || '').trim(),
          reference_mime_type: resolvedMimeType,
          reference_mode: referenceMode,
          reference_source_kind: sourceKind,
          reference_file_name: originalFileName || '',
          reference_has_transparency: Boolean(imageInfo.hasTransparentPixels),
          simple_reference_enabled: false,
          simple_reference_image_url: '',
          simple_reference_telegram_file_id: '',
          simple_reference_mime_type: '',
          simple_reference_source_kind: '',
          simple_reference_file_name: '',
          updated_at: new Date().toISOString(),
        };

        await promptReferenceDecisionAfterProductUpload({
          ctx,
          dbUser,
          draft: nextDraft,
        });
        return;
      }

      const initializedDraft = {
        created_at: new Date().toISOString(),
        status: 'collecting',
        reference_image_url: imageUrl,
        reference_telegram_file_id: String(fileId || '').trim(),
        reference_mime_type: resolvedMimeType,
        reference_mode: referenceMode,
        reference_source_kind: sourceKind,
        reference_file_name: originalFileName || '',
        reference_has_transparency: Boolean(imageInfo.hasTransparentPixels),
        simple_reference_enabled: false,
        simple_reference_image_url: '',
        simple_reference_telegram_file_id: '',
        simple_reference_mime_type: '',
        simple_reference_source_kind: '',
        simple_reference_file_name: '',
        product_focus: '',
        main_theme: '',
        visual_mood: '',
        dynamic_elements: '',
        color_palette: '',
        background_environment: '',
        brand_name: '',
        lighting: '',
        format: '1:1',
        cta: 'None',
        additional_directives: '',
        brand_logo_file: '',
        brand_logo_telegram_file_id: '',
        brand_logo_mime_type: '',
        brand_logo_source_kind: '',
        brand_logo_file_name: '',
        brand_logo_has_transparency: false,
        updated_at: new Date().toISOString(),
      };

      await promptReferenceDecisionAfterProductUpload({
        ctx,
        dbUser,
        draft: initializedDraft,
      });
    } catch (error) {
      console.error('Telegram image processing failed:', error.message);
      await ctx.reply(`Processing failed: ${error.message || 'Unexpected error'}`);
    }
  };

  bot.on('photo', async (ctx) => {
    const photos = ctx.message?.photo || [];
    if (!photos.length) {
      await ctx.reply('No photo was found in this message.');
      return;
    }

    const largestPhoto = photos[photos.length - 1];
    await handleTelegramImageUpload({
      ctx,
      fileId: largestPhoto.file_id,
      sourceKind: 'photo',
      inputMimeType: 'image/jpeg',
      originalFileName: '',
    });
  });

  bot.on('document', async (ctx) => {
    const document = ctx.message?.document;
    if (!document?.file_id) {
      await ctx.reply('No document was found in this message.');
      return;
    }

    const mimeType = String(document.mime_type || '');
    const fileName = String(document.file_name || '');
    const fileExt = getFileExtension(fileName);
    const looksLikeImage =
      mimeType.startsWith('image/') ||
      ['.png', '.jpg', '.jpeg', '.webp'].includes(fileExt);

    if (!looksLikeImage) {
      await ctx.reply('Please upload an image as a Document/File. Best results come from a background-removed PNG.');
      return;
    }

    await handleTelegramImageUpload({
      ctx,
      fileId: document.file_id,
      sourceKind: 'document',
      inputMimeType: mimeType,
      originalFileName: fileName,
    });
  });

  bot.catch((error) => {
    console.error('Telegram bot error:', error.message);
  });

  bot.startGenerationWorker = startTelegramGenerationWorker;
  bot.stopGenerationWorker = stopTelegramGenerationWorker;

  return bot;
};

let telegramBot = null;
const registeredTelegramWebhookPaths = new Set();

const ensureTelegramWebhookRoute = (webhookPath) => {
  if (registeredTelegramWebhookPaths.has(webhookPath)) {
    return;
  }
  app.post(webhookPath, (req, res) => {
    if (!telegramBot) {
      return res.status(503).json({ error: 'Telegram bot is not running' });
    }
    return telegramBot.handleUpdate(req.body, res);
  });
  registeredTelegramWebhookPaths.add(webhookPath);
};

const registerTelegramMenuCommands = async () => {
  if (!telegramBot) {
    return;
  }
  try {
    await telegramBot.telegram.setMyCommands(TELEGRAM_MENU_COMMANDS);
    console.log('Telegram menu commands registered');
  } catch (error) {
    console.warn('Failed to register Telegram menu commands:', error.message);
  }
};

const stopTelegramRuntime = async (reason = 'runtime-restart') => {
  if (!telegramBot) {
    return;
  }
  try {
    if (typeof telegramBot.stopGenerationWorker === 'function') {
      telegramBot.stopGenerationWorker();
    }
  } catch (error) {
    console.warn('Failed to stop Telegram generation worker:', error.message);
  }
  try {
    await telegramBot.telegram.deleteWebhook();
  } catch (error) {
    // Safe to ignore when polling mode is active or webhook was never set.
  }
  try {
    telegramBot.stop(reason);
  } catch (error) {
    console.warn('Failed to stop Telegram bot cleanly:', error.message);
  }
  telegramBot = null;
};

const startTelegramRuntime = async ({ restart = false } = {}) => {
  const botToken = String(process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!botToken) {
    if (telegramBot) {
      await stopTelegramRuntime('telegram-disabled');
    }
    console.warn('Telegram runtime disabled: bot token is missing in active connection settings.');
    return;
  }

  if (restart && telegramBot) {
    await stopTelegramRuntime('telegram-reconfigured');
  }

  if (!telegramBot) {
    telegramBot = setupTelegramBot();
    if (!telegramBot) {
      return;
    }
  }

  await registerTelegramMenuCommands();

  const requestedMode = String(process.env.TELEGRAM_MODE || 'polling').toLowerCase();
  const mode = requestedMode === 'webhook'
    ? 'webhook'
    : (IS_SERVERLESS_RUNTIME ? 'webhook' : 'polling');
  if (mode !== requestedMode) {
    process.env.TELEGRAM_MODE = mode;
  }
  if (mode === 'webhook') {
    const webhookPath = normalizeWebhookPath(process.env.TELEGRAM_WEBHOOK_PATH || '/webhook');
    process.env.TELEGRAM_WEBHOOK_PATH = webhookPath;
    ensureTelegramWebhookRoute(webhookPath);

    const publicServerUrl = String(process.env.PUBLIC_SERVER_URL || '').trim();
    if (publicServerUrl) {
      const webhookUrl = `${publicServerUrl.replace(/\/$/, '')}${webhookPath}`;
      await telegramBot.telegram.setWebhook(webhookUrl);
      console.log(`Telegram webhook configured: ${webhookUrl}`);
    } else {
      console.warn('TELEGRAM_MODE=webhook but PUBLIC_SERVER_URL is missing; webhook URL was not registered.');
    }

    if (typeof telegramBot.startGenerationWorker === 'function') {
      telegramBot.startGenerationWorker();
    }
    return;
  }

  if (IS_SERVERLESS_RUNTIME) {
    console.warn('Skipping Telegram polling launch in serverless runtime. Configure webhook mode instead.');
    return;
  }

  await telegramBot.launch();
  console.log('Telegram bot started in polling mode');
  if (typeof telegramBot.startGenerationWorker === 'function') {
    telegramBot.startGenerationWorker();
  }
};

const removeBackgroundImageData = async (imageData, provider = 'gemini') => {
  if (!imageData) {
    throw new Error('Image data is required');
  }

  const payload = parseDataUrl(imageData);
  if (!payload) {
    throw new Error('Invalid image format');
  }
  if (!payload.buffer || payload.buffer.length < 64) {
    throw new Error('Image data looks incomplete');
  }

  await sharp(payload.buffer, { failOnError: false, sequentialRead: true }).metadata();

  const selectedProvider = String(provider || 'gemini').toLowerCase();

  if (selectedProvider === 'gemini') {
    const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
    const geminiApiKey = process.env.GEMINI_API_KEY;
    const { response } = await postGeminiWithFallback({
      model: geminiModel,
      apiKey: geminiApiKey,
      payload: {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inline_data: {
                  data: payload.buffer.toString('base64'),
                  mime_type: payload.mimeType,
                },
              },
              {
                text:
                  'Remove the background and return a transparent PNG. Keep only the main subject and remove everything else (props, secondary objects, text, and scenery). If multiple subjects exist, keep the most prominent one. Keep edges clean and the subject crisp.',
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
        },
      },
    });

    const extractedImage = extractGeminiImagePayload(response.data, 'image/png');
    if (!extractedImage?.base64) {
      const summary = summarizeGeminiNoImage(response.data);
      throw new Error(summary ? `Gemini did not return image data (${summary})` : 'Gemini did not return image data');
    }

    return `data:${extractedImage.mimeType || 'image/png'};base64,${extractedImage.base64}`;
  }

  const apiKey = process.env.REMOVE_BG_API_KEY;
  if (!apiKey) {
    throw new Error('Remove.bg API key missing');
  }

  if (typeof FormData === 'undefined') {
    throw new Error('FormData not available in this Node runtime');
  }

  const formData = new FormData();
  const fileBlob = new Blob([payload.buffer], {
    type: payload.mimeType || 'image/png',
  });
  formData.append('image_file', fileBlob, 'upload.png');
  formData.append('size', 'auto');

  const response = await fetch('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || 'Remove.bg request failed');
  }

  const arrayBuffer = await response.arrayBuffer();
  const outputBase64 = Buffer.from(arrayBuffer).toString('base64');
  return `data:image/png;base64,${outputBase64}`;
};

const extractProductCutoutForComposite = async (imageData) => {
  if (!imageData) {
    throw new Error('Image data is required');
  }

  const payload = parseDataUrl(imageData);
  if (!payload?.buffer) {
    throw new Error('Invalid image format');
  }

  try {
    if (process.env.REMOVE_BG_API_KEY) {
      console.log('Using remove.bg for reliable product cutout...');
      return await removeBackgroundImageData(imageData, 'third_party');
    }
  } catch (removeBgError) {
    console.warn('Remove.bg composite cutout failed:', removeBgError.message);
  }

  console.log('Falling back to Gemini for product cutout...');
  const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const geminiApiKey = process.env.GEMINI_API_KEY;
  const { response } = await postGeminiWithFallback({
    model: geminiModel,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inline_data: {
                data: payload.buffer.toString('base64'),
                mime_type: payload.mimeType,
              },
            },
            {
              text:
                'Extract only the main product as a clean transparent PNG. ' +
                'Treat any checkerboard pattern, white/gray preview background, uploader UI background, shadows, labels outside the product, and surrounding empty area as removable background. ' +
                'Keep the product itself fully intact, crisp, centered, and isolated. ' +
                'Return only the cutout product with transparent background.',
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    },
  });

  const extractedImage = extractGeminiImagePayload(response.data, 'image/png');
  if (!extractedImage?.base64) {
    const summary = summarizeGeminiNoImage(response.data);
    throw new Error(summary ? `Gemini did not return product cutout (${summary})` : 'Gemini did not return product cutout');
  }

  return `data:${extractedImage.mimeType || 'image/png'};base64,${extractedImage.base64}`;
};

app.post('/api/remove-background', requireAuth, async (req, res) => {
  const { imageData, provider } = req.body;
  if (!imageData) {
    return res.status(400).json({ error: 'Image data is required' });
  }

  const payload = parseDataUrl(imageData);
  if (!payload) {
    return res.status(400).json({ error: 'Invalid image format' });
  }
  if (!payload.buffer || payload.buffer.length < 64) {
    return res.status(400).json({ error: 'Image data looks incomplete' });
  }

  try {
    await sharp(payload.buffer, { failOnError: false, sequentialRead: true }).metadata();
  } catch (error) {
    return res.status(400).json({ error: 'Unable to decode image. Please re-upload or use a smaller file.' });
  }

  const selectedProvider = String(provider || 'third_party').toLowerCase();

  try {
    const outputDataUrl = await removeBackgroundImageData(imageData, selectedProvider);
    return res.json({
      imageUrl: outputDataUrl,
    });
  } catch (error) {
    const message = error?.message || 'Background removal failed';
    console.error('Background removal failed:', message);
    return res.status(500).json({ error: 'Background removal failed', details: message });
  }
});

const extractGeminiText = (data) => {
  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      if (typeof part?.text === 'string') {
        return part.text;
      }
    }
  }
  return '';
};

const redactUrlSecrets = (value) =>
  String(value || '')
    .replace(/([?&]key=)[^&]+/gi, '$1***')
    .replace(/([?&]x-goog-api-key=)[^&]+/gi, '$1***');

const sleepMs = (value) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number(value) || 0));
  });

const getUpstreamHttpStatus = (error) => {
  const status =
    error?.response?.status ||
    error?.details?.status ||
    error?.cause?.response?.status ||
    null;
  return Number.isFinite(Number(status)) ? Number(status) : null;
};

const mapUpstreamStatusToClientStatus = (upstreamStatus) => {
  if (upstreamStatus === 429) return 429;
  if (upstreamStatus && upstreamStatus >= 500 && upstreamStatus < 600) return 503;
  return 500;
};

const isRetriableUpstreamError = (error) => {
  const retriableStatuses = new Set([408, 425, 429, 500, 502, 503, 504]);
  const retriableCodes = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENOTFOUND',
    'ECONNREFUSED',
  ]);
  const status = getUpstreamHttpStatus(error);
  if (status && retriableStatuses.has(status)) return true;

  const code = String(error?.code || error?.cause?.code || '').toUpperCase();
  if (code && retriableCodes.has(code)) return true;

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('timeout') || message.includes('socket hang up') || message.includes('network error')) {
    return true;
  }
  return false;
};

const isLegacyGeminiImageEndpoint = (value) => {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('/models/imagegeneration:generate');
};

const buildGeminiRequestUrlCandidates = ({ model, apiKey }) => {
  const defaultUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const rawUrls = [
    String(process.env.GEMINI_IMAGE_URL || '').trim(),
    String(process.env.GEMINI_IMAGE_FALLBACK_URL || '').trim(),
    defaultUrl,
  ].filter(Boolean);

  const normalizedUrls = [];
  for (const rawUrl of rawUrls) {
    if (isLegacyGeminiImageEndpoint(rawUrl)) {
      console.warn(
        `[Gemini] Ignoring legacy/invalid endpoint from environment: ${redactUrlSecrets(rawUrl)}`
      );
      continue;
    }
    normalizedUrls.push(rawUrl);
  }

  if (!normalizedUrls.length) {
    normalizedUrls.push(defaultUrl);
  }

  const withKeys = normalizedUrls.map((rawUrl) => {
    if (!apiKey || rawUrl.includes('key=')) {
      return rawUrl;
    }
    return `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
  });

  return [...new Set(withKeys)];
};

const postGeminiWithFallback = async ({ model, apiKey, payload }) => {
  const urlCandidates = buildGeminiRequestUrlCandidates({ model, apiKey });
  let lastError = null;

  for (let i = 0; i < urlCandidates.length; i += 1) {
    const requestUrl = urlCandidates[i];
    const isLast = i === urlCandidates.length - 1;
    let endpointError = null;
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios.post(requestUrl, payload, {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
          },
          timeout: 60000,
        });
        return { response, requestUrl };
      } catch (error) {
        endpointError = error;
        const status = getUpstreamHttpStatus(error);
        const statusText = error?.response?.statusText;
        const brief = [error?.message, status ? `status=${status}` : '', statusText || '']
          .filter(Boolean)
          .join(', ');
        const shouldRetryHere = isRetriableUpstreamError(error) && attempt < maxAttempts;

        if (shouldRetryHere) {
          const waitMs = Math.min(2500, 600 * (2 ** (attempt - 1)));
          console.warn(
            `[Gemini] Transient failure at ${redactUrlSecrets(requestUrl)}. Retrying attempt ${attempt + 1}/${maxAttempts} in ${waitMs}ms... (${brief})`
          );
          await sleepMs(waitMs);
          continue;
        }
        break;
      }
    }

    if (endpointError) {
      lastError = endpointError;
      const status = getUpstreamHttpStatus(endpointError);
      const statusText = endpointError?.response?.statusText;
      const brief = [endpointError?.message, status ? `status=${status}` : '', statusText || '']
        .filter(Boolean)
        .join(', ');
      if (!isLast) {
        console.warn(
          `[Gemini] Request failed at ${redactUrlSecrets(requestUrl)}. Trying next endpoint... (${brief})`
        );
      }
    }
  }

  const attempted = urlCandidates.map(redactUrlSecrets).join(' | ');
  const error = new Error(lastError?.message || 'Gemini request failed');
  error.cause = lastError;
  error.details = {
    attempted,
    status: lastError?.response?.status || null,
    data: lastError?.response?.data || null,
  };
  throw error;
};

const postGeminiWithModelFallback = async ({ models, apiKey, payload, purpose = 'Gemini request' }) => {
  const modelList = Array.from(
    new Set(
      (Array.isArray(models) ? models : [models])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )
  );

  let lastError = null;
  for (let index = 0; index < modelList.length; index += 1) {
    const model = modelList[index];
    try {
      const result = await postGeminiWithFallback({ model, apiKey, payload });
      return { ...result, model };
    } catch (error) {
      lastError = error;
      const status = error?.details?.status || error?.cause?.response?.status || '';
      const brief = [error?.message || 'Unknown error', status ? `status=${status}` : '']
        .filter(Boolean)
        .join(', ');
      if (index < modelList.length - 1) {
        console.warn(`[Gemini] ${purpose} failed with model ${model}. Trying next model... (${brief})`);
      }
    }
  }

  const error = new Error(lastError?.message || `${purpose} failed`);
  error.cause = lastError;
  throw error;
};

const summarizeForTerminal = (value, limit = 220) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
};

const logInfo = (scope, message, details = '') => {
  const suffix = details ? ` | ${details}` : '';
  console.log(`[${scope}] ${message}${suffix}`);
};

const logWarn = (scope, message, details = '') => {
  const suffix = details ? ` | ${details}` : '';
  console.warn(`[${scope}] ${message}${suffix}`);
};

const normalizeBase64Payload = (value, minimumLength = 128) => {
  if (typeof value !== 'string') {
    return '';
  }
  const cleaned = String(value || '')
    .replace(/\s+/g, '')
    .replace(/^data:[^,]+,/i, '');
  if (cleaned.length < minimumLength) {
    return '';
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(cleaned)) {
    return '';
  }
  return cleaned;
};

const extractImageDataUrlFromText = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)/i);
  if (!match) {
    return null;
  }
  const mimeType = String(match[1] || '').trim().toLowerCase() || 'image/png';
  const base64 = normalizeBase64Payload(match[2] || '');
  if (!base64) {
    return null;
  }
  return { base64, mimeType };
};

const extractGeminiImagePayload = (data, fallbackMimeType = 'image/png') => {
  const candidates = data?.candidates || [];
  for (let i = 0; i < candidates.length; i += 1) {
    const parts = candidates[i]?.content?.parts || [];
    for (let j = 0; j < parts.length; j += 1) {
      const part = parts[j] || {};
      const inlineData = part?.inlineData || part?.inline_data || part?.image?.inlineData || part?.image?.inline_data;
      const base64FromInline = normalizeBase64Payload(
        inlineData?.data || inlineData?.bytesBase64Encoded || inlineData?.image || ''
      );
      if (base64FromInline) {
        return {
          base64: base64FromInline,
          mimeType: inlineData?.mimeType || inlineData?.mime_type || fallbackMimeType,
          source: `candidates[${i}].parts[${j}]`,
        };
      }

      const textDataUrl = extractImageDataUrlFromText(part?.text || '');
      if (textDataUrl) {
        return {
          ...textDataUrl,
          source: `candidates[${i}].parts[${j}].text-data-url`,
        };
      }

      const base64FromText = normalizeBase64Payload(part?.text || '', 1024);
      if (base64FromText) {
        return {
          base64: base64FromText,
          mimeType: fallbackMimeType,
          source: `candidates[${i}].parts[${j}].text-base64`,
        };
      }
    }
  }

  const topLevelCandidates = [
    {
      data: data?.images?.[0]?.image,
      mimeType: data?.images?.[0]?.mimeType || data?.images?.[0]?.mime_type,
      source: 'images[0].image',
    },
    {
      data: data?.images?.[0]?.bytesBase64Encoded,
      mimeType: data?.images?.[0]?.mimeType || data?.images?.[0]?.mime_type,
      source: 'images[0].bytesBase64Encoded',
    },
    {
      data: data?.generatedImages?.[0]?.image?.imageBytes,
      mimeType: data?.generatedImages?.[0]?.image?.mimeType || data?.generatedImages?.[0]?.image?.mime_type,
      source: 'generatedImages[0].image.imageBytes',
    },
    {
      data: data?.generatedImages?.[0]?.bytesBase64Encoded,
      mimeType: data?.generatedImages?.[0]?.mimeType || data?.generatedImages?.[0]?.mime_type,
      source: 'generatedImages[0].bytesBase64Encoded',
    },
    {
      data: data?.predictions?.[0]?.bytesBase64Encoded,
      mimeType: data?.predictions?.[0]?.mimeType || data?.predictions?.[0]?.mime_type,
      source: 'predictions[0].bytesBase64Encoded',
    },
    {
      data: data?.prediction?.image?.bytesBase64Encoded,
      mimeType: data?.prediction?.image?.mimeType || data?.prediction?.image?.mime_type,
      source: 'prediction.image.bytesBase64Encoded',
    },
    {
      data: data?.image,
      mimeType: data?.mimeType || data?.mime_type,
      source: 'image',
    },
  ];

  for (const item of topLevelCandidates) {
    const base64 = normalizeBase64Payload(item?.data || '');
    if (!base64) {
      continue;
    }
    return {
      base64,
      mimeType: item?.mimeType || fallbackMimeType,
      source: item?.source || 'unknown',
    };
  }

  const textDataUrl = extractImageDataUrlFromText(extractGeminiText(data));
  if (textDataUrl) {
    return {
      ...textDataUrl,
      source: 'candidate-text-data-url',
    };
  }

  return null;
};

const summarizeGeminiNoImage = (data) => {
  const finishReasons = (data?.candidates || [])
    .map((candidate) => candidate?.finishReason)
    .filter(Boolean);
  const promptBlockReason = String(data?.promptFeedback?.blockReason || '').trim();
  const blockedCategories = (data?.promptFeedback?.safetyRatings || [])
    .filter((rating) => rating?.blocked)
    .map((rating) => rating?.category)
    .filter(Boolean);
  const textSnippet = extractGeminiText(data).replace(/\s+/g, ' ').trim().slice(0, 180);

  const parts = [];
  if (finishReasons.length) {
    parts.push(`finishReason=${[...new Set(finishReasons)].join('|')}`);
  }
  if (promptBlockReason) {
    parts.push(`blockReason=${promptBlockReason}`);
  }
  if (blockedCategories.length) {
    parts.push(`safety=${[...new Set(blockedCategories)].join('|')}`);
  }
  if (textSnippet) {
    parts.push(`text="${textSnippet}"`);
  }
  return parts.join(', ');
};

const summarizeGenerationError = (error) => {
  if (!error) {
    return '';
  }
  const details = error?.details || error?.cause?.details || null;
  const responseData = error?.response?.data || details?.data || null;
  const responseSummary = responseData ? summarizeGeminiNoImage(responseData) : '';
  const message = String(error?.message || '').trim();
  return [message, responseSummary].filter(Boolean).join(' | ').trim();
};

const isLikelySafetyFilterFailure = (text) => {
  const value = String(text || '').toLowerCase();
  if (!value) {
    return false;
  }
  return (
    value.includes('blockreason=') ||
    value.includes('promptfeedback') ||
    value.includes('safety=') ||
    value.includes('safety filter') ||
    value.includes('safety block') ||
    value.includes('prohibited_content') ||
    value.includes('finishreason=safety')
  );
};

const tryStrictModeBackupWithExternalModel = async ({
  endpoint,
  apiKey = '',
  promptText = '',
  requestedAspectRatio = '',
  referencePayload,
  productPayload,
  referencePlacement = null,
}) => {
  const endpointUrl = String(endpoint || '').trim();
  if (!endpointUrl || !referencePayload?.buffer || !productPayload?.buffer) {
    return null;
  }

  const response = await axios.post(
    endpointUrl,
    {
      mode: 'strict_reference_lock',
      promptText: String(promptText || ''),
      requestedAspectRatio: String(requestedAspectRatio || ''),
      referenceImage: `data:${referencePayload.mimeType};base64,${referencePayload.buffer.toString('base64')}`,
      productImage: `data:${productPayload.mimeType};base64,${productPayload.buffer.toString('base64')}`,
      referencePlacement: referencePlacement || undefined,
    },
    {
      timeout: Number.isFinite(Number(process.env.STRICT_MODE_BACKUP_TIMEOUT_MS))
        ? Math.max(8000, Math.floor(Number(process.env.STRICT_MODE_BACKUP_TIMEOUT_MS)))
        : 45000,
      headers: apiKey
        ? { Authorization: `Bearer ${apiKey}` }
        : undefined,
    }
  );

  const payload = response?.data || {};
  const normalizedDirectBase64 = normalizeBase64Payload(
    payload?.imageBase64 || payload?.b64_json || payload?.image || ''
  );
  if (normalizedDirectBase64) {
    return {
      base64: normalizedDirectBase64,
      mimeType: String(payload?.mimeType || payload?.mime_type || 'image/png').trim() || 'image/png',
      provider: String(payload?.provider || payload?.model || 'external-backup').trim() || 'external-backup',
    };
  }

  const dataUrlSource = String(payload?.imageDataUrl || payload?.image_url || payload?.url || '').trim();
  const extractedDataUrl = extractImageDataUrlFromText(dataUrlSource);
  if (extractedDataUrl?.base64) {
    return {
      base64: extractedDataUrl.base64,
      mimeType: extractedDataUrl.mimeType || 'image/png',
      provider: String(payload?.provider || payload?.model || 'external-backup').trim() || 'external-backup',
    };
  }

  return null;
};

const safeJsonParse = (text) => {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (innerError) {
        return null;
      }
    }
    return null;
  }
};

const getMessageText = (message) => {
  if (!message) {
    return '';
  }
  const content = message.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part?.text || '';
      })
      .join('');
  }
  return '';
};

const normalizeText = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

const isCaptionWeak = (caption, prompt) => {
  const normCaption = normalizeText(caption);
  const normPrompt = normalizeText(prompt);
  if (!normCaption) {
    return true;
  }
  if (normCaption === normPrompt) {
    return true;
  }
  if (normCaption.startsWith('create ') || normCaption.startsWith('add ') || normCaption.startsWith('make ')) {
    return true;
  }
  if (normPrompt && normCaption.includes(normPrompt)) {
    return true;
  }
  return false;
};

const generateGeminiCaptionFallback = async ({ promptForModel, backgroundPrompt = '' }) => {
  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    return '';
  }
  const geminiTextModel = normalizeGeminiModelName(
    String(process.env.GEMINI_TEXT_MODEL || '').trim() ||
    String(process.env.GEMINI_MODEL || '').trim() ||
    'gemini-2.5-flash'
  );
  const promptText = backgroundPrompt
    ? `Write one concise ad caption (5-12 words).\nUser prompt: ${promptForModel}\nBackground intent: ${backgroundPrompt}\nReturn only caption text.`
    : `Write one concise ad caption (5-12 words).\nUser prompt: ${promptForModel}\nReturn only caption text.`;

  try {
    const { response } = await postGeminiWithFallback({
      model: geminiTextModel,
      apiKey: geminiApiKey,
      payload: {
        contents: [
          {
            role: 'user',
            parts: [{ text: promptText }],
          },
        ],
      },
    });
    const text = extractGeminiText(response.data);
    return String(text || '').replace(/^["'\s]+|["'\s]+$/g, '').slice(0, 300).trim();
  } catch (error) {
    console.warn('Gemini caption fallback failed:', error.message);
    return '';
  }
};

const placeProductIntoSceneWithGemini = async ({
  backgroundBase64,
  productPayload,
  referencePayload,
  referencePlacement,
  mergedReferencePlan = null,
  promptText = '',
  requestedAspectRatio = '',
  lockBackgroundOutsidePlacement = false,
  autoPlacement = false,
}) => {
  if (!backgroundBase64 || !productPayload?.buffer) {
    throw new Error('Background image and product cutout are required for Gemini placement edit');
  }

  const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const backgroundBuffer = Buffer.from(backgroundBase64, 'base64');
  const backgroundMeta = await sharp(backgroundBuffer).metadata();
  const placement = normalizeReferencePlacement(referencePlacement || {});
  const analyzedPlacement = mergedReferencePlan?.placement
    ? normalizeReferencePlacement(mergedReferencePlan.placement)
    : null;
  const sceneBlueprint = String(mergedReferencePlan?.sceneBlueprint || '').trim();
  const productAreaNotes = String(mergedReferencePlan?.productAreaNotes || '').trim();
  const qualityNotes = String(mergedReferencePlan?.qualityNotes || '').trim();
  const supportSurfaceHint = String(analyzedPlacement?.supportSurface || placement?.supportSurface || '').trim();
  const contactEdgeHint = String(analyzedPlacement?.contactEdge || placement?.contactEdge || '').trim();
  const shouldForceInsideContainerPlacement =
    /basket|container|bowl|bucket|tray|inside|within/i.test(
      `${sceneBlueprint} ${productAreaNotes} ${supportSurfaceHint} ${contactEdgeHint}`
    );

  const placementPrompt = autoPlacement
    ? (
      `You are editing a regenerated advertising background by placing the uploaded transparent product naturally into this scene. ` +
      `Use the regenerated background image as the base scene and keep its composition intact. ` +
      `Use the transparent product image exactly as the hero product. Do not redesign it, relabel it, or create a second product. ` +
      `HARD PRODUCT COUNT RULE: exactly one hero product container must be visible in the final image. Zero duplicates, zero partial second caps/necks/bodies. ` +
      `HARD CLEANUP RULE: if any remnant of the old product appears (cap, neck, label fragment, silhouette, reflection), remove it completely. ` +
      `Decide the best product placement, scale, and orientation from scene geometry, perspective, support surfaces, and lighting. ` +
      `${analyzedPlacement ? (
        `Use this slot-size hint extracted from the original reference product: center (${analyzedPlacement.centerX.toFixed(3)}, ${analyzedPlacement.centerY.toFixed(3)}), ` +
        `width ratio ${analyzedPlacement.widthRatio.toFixed(3)}, height ratio ${analyzedPlacement.heightRatio.toFixed(3)}, ` +
        `rotation ${analyzedPlacement.rotationDeg.toFixed(1)} degrees. ` +
        `Keep your final product size and framing very close to this hint unless physical perspective requires a small adjustment. `
      ) : ''}` +
      `${analyzedPlacement?.supportSurface ? `Preferred support surface from analysis: ${analyzedPlacement.supportSurface}. ` : ''}` +
      `${analyzedPlacement?.contactEdge ? `Preferred contact edge from analysis: ${analyzedPlacement.contactEdge}. ` : ''}` +
      `${sceneBlueprint ? `Scene blueprint context: ${sceneBlueprint}. ` : ''}` +
      `${productAreaNotes ? `Additional scene context: ${productAreaNotes}. ` : ''}` +
      `${qualityNotes ? `Quality target: ${qualityNotes}. ` : ''}` +
      `${analyzedPlacement?.preserveForegroundOccluders ? 'OCCLUSION DEPTH LOCK: keep foreground/background layering exactly; preserve which elements pass in front of or behind the product exactly as in reference context. ' : ''}` +
      `${shouldForceInsideContainerPlacement ? (
        `CRITICAL placement rule: the product must be physically inside the basket/container cavity, not floating above or in front of it. ` +
        `The lower portion of the product must be partially occluded by the basket rim/fabric so depth reads correctly. ` +
        `Maintain realistic contact with the interior base and ensure perspective/occlusion clearly indicates "inside". `
      ) : ''}` +
      `CRITICAL canvas rule: keep the exact same framing and aspect ratio as the provided background image. ` +
      `Do not crop, pad, zoom, or extend canvas beyond the background framing. ` +
      `Add realistic grounding, contact shadow, reflections, and perspective so the product looks physically integrated. ` +
      `Do not alter the overall background layout, major props, or camera framing. ` +
      `Before returning the image, internally self-check: single product only, no old-product residue, no duplicate forms, no pasted/floating look. If any check fails, correct and regenerate once before returning. ` +
      `Keep the result sharp, premium, and photorealistic. Aspect ratio: ${requestedAspectRatio || '1:1'}. ` +
      `${promptText ? `User prompt context: ${promptText}.` : ''}`
    )
    : (
      `You are editing a regenerated advertising background by placing the uploaded cutout product into the correct hero slot. ` +
      `Use the regenerated background image as the base scene and keep its composition intact. ` +
      `Use the transparent product image exactly as the hero product. Do not redesign it, relabel it, or create a second product. ` +
      `HARD PRODUCT COUNT RULE: exactly one hero product container must be visible in the final image. Zero duplicates, zero partial second caps/necks/bodies. ` +
      `HARD CLEANUP RULE: if any remnant of the old product appears (cap, neck, label fragment, silhouette, reflection), remove it completely. ` +
      `Place the product at normalized center (${placement.centerX.toFixed(3)}, ${placement.centerY.toFixed(3)}) with approximate width ratio ${placement.widthRatio.toFixed(3)}, height ratio ${placement.heightRatio.toFixed(3)}, and rotation ${placement.rotationDeg.toFixed(1)} degrees. ` +
      `${placement.supportSurface ? `The product must rest on the ${placement.supportSurface}. ` : ''}` +
      `${placement.contactEdge ? `Primary contact edge: ${placement.contactEdge}. ` : ''}` +
      `${placement.preserveForegroundOccluders ? 'If the original reference had small foreground props overlapping the product area, preserve that natural layering and keep the same front/back depth order exactly. ' : ''}` +
      `${sceneBlueprint ? `Scene blueprint: ${sceneBlueprint}. ` : ''}` +
      `${productAreaNotes ? `Product area notes: ${productAreaNotes}. ` : ''}` +
      `${qualityNotes ? `Quality target: ${qualityNotes}. ` : ''}` +
      `Add realistic grounding, contact shadow, reflections, and perspective so the product looks naturally placed in that exact slot. ` +
      `Do not move the chair, umbrella, shoreline, or major props. Do not create a placeholder box, matte panel, or artificial patch behind the product. ` +
      `Before returning the image, internally self-check: single product only, no old-product residue, no duplicate forms, no pasted/floating look. If any check fails, correct and regenerate once before returning. ` +
      `Keep the result sharp, premium, and photorealistic. Aspect ratio: ${requestedAspectRatio || '1:1'}. ` +
      `${promptText ? `User prompt context: ${promptText}.` : ''}`
    );

  const parts = [
    {
      text: 'Regenerated background scene to edit. Keep this as the base composition:',
    },
    {
      inline_data: {
        data: backgroundBase64,
        mime_type: 'image/png',
      },
    },
    {
      text: 'Transparent product image to place into the hero slot:',
    },
    {
      inline_data: {
        data: productPayload.buffer.toString('base64'),
        mime_type: productPayload.mimeType || 'image/png',
      },
    },
  ];

  if (referencePayload?.buffer) {
    parts.push({
      text: 'Original reference image for slot/layout guidance only:',
    });
    parts.push({
      inline_data: {
        data: referencePayload.buffer.toString('base64'),
        mime_type: referencePayload.mimeType,
      },
    });
  }

  parts.push({ text: placementPrompt });

  const { response, requestUrl } = await postGeminiWithFallback({
    model: geminiModel,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    },
  });

  logInfo('Gemini', 'Placed product into regenerated background', redactUrlSecrets(requestUrl));
  const extractedImage = extractGeminiImagePayload(response.data, 'image/png');
  if (!extractedImage?.base64) {
    throw new Error('Gemini returned no placement-edited image data');
  }
  let finalBase64 = extractedImage.base64;
  const generatedMeta = await sharp(Buffer.from(finalBase64, 'base64')).metadata();
  if (
    backgroundMeta?.width &&
    backgroundMeta?.height &&
    (
      generatedMeta?.width !== backgroundMeta.width ||
      generatedMeta?.height !== backgroundMeta.height
    )
  ) {
    const normalizedToBackground = await sharp(Buffer.from(finalBase64, 'base64'))
      .resize(backgroundMeta.width, backgroundMeta.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    finalBase64 = normalizedToBackground.toString('base64');
  }
  if (lockBackgroundOutsidePlacement) {
    const lockPlacement = normalizeReferencePlacement(referencePlacement || {});
    const placedBuffer = Buffer.from(extractedImage.base64, 'base64');
    const bgWidth = backgroundMeta.width || 1024;
    const bgHeight = backgroundMeta.height || 1024;
    const normalizedPlaced = await sharp(placedBuffer)
      .resize(bgWidth, bgHeight, { fit: 'fill' })
      .png()
      .toBuffer();

    const centerX = Math.min(1, Math.max(0, Number(lockPlacement.centerX || 0.5)));
    const centerY = Math.min(1, Math.max(0, Number(lockPlacement.centerY || 0.5)));
    const patchWidth = Math.max(
      2,
      Math.min(
        bgWidth,
        Math.round(bgWidth * Math.min(0.9, Math.max(0.16, Number(lockPlacement.widthRatio || 0.34) * 1.45)))
      )
    );
    const patchHeight = Math.max(
      2,
      Math.min(
        bgHeight,
        Math.round(bgHeight * Math.min(0.95, Math.max(0.2, Number(lockPlacement.heightRatio || 0.48) * 1.7)))
      )
    );
    const patchLeft = Math.max(0, Math.min(bgWidth - patchWidth, Math.round((bgWidth * centerX) - (patchWidth / 2))));
    const patchTop = Math.max(0, Math.min(bgHeight - patchHeight, Math.round((bgHeight * centerY) - (patchHeight / 2))));

    const placementPatch = await sharp(normalizedPlaced)
      .extract({
        left: patchLeft,
        top: patchTop,
        width: patchWidth,
        height: patchHeight,
      })
      .png()
      .toBuffer();

    const featherPx = Math.max(
      14,
      Math.min(
        72,
        Math.round(Math.min(patchWidth, patchHeight) * 0.12)
      )
    );
    const maskRaw = Buffer.alloc(patchWidth * patchHeight * 4);
    for (let y = 0; y < patchHeight; y += 1) {
      for (let x = 0; x < patchWidth; x += 1) {
        const edgeDistance = Math.min(
          x,
          patchWidth - 1 - x,
          y,
          patchHeight - 1 - y
        );
        const alpha = edgeDistance >= featherPx
          ? 255
          : Math.max(0, Math.min(255, Math.round((edgeDistance / featherPx) * 255)));
        const idx = (y * patchWidth + x) * 4;
        maskRaw[idx] = 255;
        maskRaw[idx + 1] = 255;
        maskRaw[idx + 2] = 255;
        maskRaw[idx + 3] = alpha;
      }
    }
    const featherMask = await sharp(maskRaw, {
      raw: {
        width: patchWidth,
        height: patchHeight,
        channels: 4,
      },
    })
      .png()
      .toBuffer();
    const featheredPlacementPatch = await sharp(placementPatch)
      .composite([
        {
          input: featherMask,
          blend: 'dest-in',
        },
      ])
      .png()
      .toBuffer();

    const lockedComposite = await sharp(backgroundBuffer)
      .resize(bgWidth, bgHeight, { fit: 'cover' })
      .composite([
        {
          input: featheredPlacementPatch,
          left: patchLeft,
          top: patchTop,
        },
      ])
      .png()
      .toBuffer();
    finalBase64 = lockedComposite.toString('base64');
  }
  return {
    base64: finalBase64,
    mimeType: extractedImage.mimeType || 'image/png',
  };
};

const inferAspectRatioFromBuffer = async (imageBuffer, fallback = '1:1') => {
  try {
    const meta = await sharp(imageBuffer).metadata();
    const width = Number(meta?.width || 0);
    const height = Number(meta?.height || 0);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return fallback;
    }
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const w = Math.round(width);
    const h = Math.round(height);
    const d = gcd(w, h) || 1;
    return `${Math.round(w / d)}:${Math.round(h / d)}`;
  } catch (error) {
    return fallback;
  }
};

const recreateReferenceBackgroundWithGemini = async ({
  referencePayload,
  promptBundle,
  promptText = '',
  requestedAspectRatio = '',
}) => {
  if (!referencePayload?.buffer) {
    throw new Error('Reference payload is required for background recreation');
  }
  const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for background recreation');
  }

  const recreationPrompt = mergeDistinctSentences(
    `Recreate the same scene from the reference as a clean, crisp, high-resolution premium ad background.`,
    `Remove the old hero product completely. Do not place any product, bottle, packshot, logo, text, watermark, or UI overlay.`,
    `HARD CLEANUP RULE: if any old product remnant is visible (cap, neck, label fragment, silhouette, or reflection), remove it entirely.`,
    `The output must contain zero product containers and zero product-like shapes; background-only scene.`,
    `Do not alter occlusion depth order of scene props; keep front/back layering consistent with the reference scene.`,
    `Keep scene composition, camera framing, lighting direction, and major props very close to the reference.`,
    `Maintain sharp natural textures with no haze, smearing, painterly softness, or heavy blur.`,
    `Before returning the image, internally self-check: background-only output, no old-product residue, no placeholder patches.`,
    promptBundle?.backgroundPrompt || '',
    promptText ? `User prompt context: ${promptText}.` : '',
    requestedAspectRatio ? `Aspect ratio: ${requestedAspectRatio}.` : ''
  );

  const { response, requestUrl } = await postGeminiWithFallback({
    model: geminiModel,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Reference image. Recreate this scene as background-only output:' },
            {
              inline_data: {
                data: referencePayload.buffer.toString('base64'),
                mime_type: referencePayload.mimeType,
              },
            },
            { text: recreationPrompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    },
  });
  logInfo('Gemini', 'Recreated background for reference pipeline', redactUrlSecrets(requestUrl));
  const extractedImage = extractGeminiImagePayload(response.data, 'image/png');
  if (!extractedImage?.base64) {
    throw new Error('Gemini returned no background recreation image data');
  }

  const targetMeta = await sharp(referencePayload.buffer).metadata();
  let finalBase64 = extractedImage.base64;
  const generatedMeta = await sharp(Buffer.from(extractedImage.base64, 'base64')).metadata();
  if (
    targetMeta?.width &&
    targetMeta?.height &&
    (
      generatedMeta?.width !== targetMeta.width ||
      generatedMeta?.height !== targetMeta.height
    )
  ) {
    const resized = await sharp(Buffer.from(extractedImage.base64, 'base64'))
      .resize(targetMeta.width, targetMeta.height, { fit: 'cover', position: 'centre' })
      .png()
      .toBuffer();
    finalBase64 = resized.toString('base64');
  }

  return {
    base64: finalBase64,
    mimeType: extractedImage.mimeType || 'image/png',
  };
};

const refinePlacedProductCompositeWithGemini = async ({
  draftBase64,
  productPayload,
  referencePayload,
  referencePlacement = null,
  mergedReferencePlan = null,
  promptText = '',
  requestedAspectRatio = '',
  strictProfile = false,
}) => {
  if (!draftBase64 || !productPayload?.buffer) {
    throw new Error('Draft composite and product payload are required for refinement');
  }

  const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    throw new Error('GEMINI_API_KEY is required for composite refinement');
  }

  const placement = referencePlacement ? normalizeReferencePlacement(referencePlacement) : null;
  const sceneBlueprint = String(mergedReferencePlan?.sceneBlueprint || '').trim();
  const productAreaNotes = String(mergedReferencePlan?.productAreaNotes || '').trim();
  const qualityNotes = String(mergedReferencePlan?.qualityNotes || '').trim();
  const shouldForceInsideContainerPlacement =
    /basket|container|bowl|bucket|tray|inside|within/i.test(
      `${sceneBlueprint} ${productAreaNotes} ${placement?.supportSurface || ''} ${placement?.contactEdge || ''}`
    );

  const refinePrompt =
    `Refine this pre-composited advertising image. The new uploaded product is already in the correct slot. ` +
    `Do NOT move, rotate, scale, reshape, relabel, repaint, or replace the product. Do NOT create a second product. ` +
    `HARD PRODUCT COUNT RULE: exactly one hero product container must be visible in final output. Zero duplicates, zero partial second caps/necks/bodies. ` +
    `HARD CLEANUP RULE: remove any old-product residue completely, including cap/neck fragments, label remnants, silhouettes, and product reflections from replaced content. ` +
    `Only improve realism by matching local lighting, contact shadow, ambient occlusion, subtle reflections, and edge blending around the product boundary. ` +
    `Keep global scene framing, props, and perspective unchanged. ` +
    `${placement?.supportSurface ? `Keep the product physically resting on the ${placement.supportSurface}. ` : ''}` +
    `${placement?.contactEdge ? `Preserve surface contact at ${placement.contactEdge}. ` : ''}` +
    `${placement?.preserveForegroundOccluders ? 'Preserve natural foreground overlaps/occluders where they cross in front of the product and keep the same front/back depth order. ' : ''}` +
    `${shouldForceInsideContainerPlacement ? 'The product must read as physically inside the container cavity with realistic rim/fabric overlap and depth. ' : ''}` +
    `${sceneBlueprint ? `Scene blueprint lock: ${sceneBlueprint}. ` : ''}` +
    `${productAreaNotes ? `Product area notes: ${productAreaNotes}. ` : ''}` +
    `${qualityNotes ? `Quality target: ${qualityNotes}. ` : ''}` +
    `${strictProfile ? 'STRICT correction mode: aggressively remove any duplicate product forms or old-product residue while preserving the single uploaded product identity and placement. ' : ''}` +
    `Do not add text, watermark, logo, UI overlays, fake labels, or artifacts. ` +
    `Before returning the image, internally self-check: single product only, no old-product residue, no duplicate forms, no pasted/floating look. If any check fails, correct and regenerate once before returning. ` +
    `Keep the output crisp, photorealistic, and premium. Aspect ratio: ${requestedAspectRatio || '1:1'}. ` +
    `${promptText ? `User prompt context: ${promptText}.` : ''}`;

  const parts = [
    {
      text: 'Pre-composited draft with the new product already placed. Keep placement locked:',
    },
    {
      inline_data: {
        data: draftBase64,
        mime_type: 'image/png',
      },
    },
  ];

  if (referencePayload?.buffer) {
    parts.push({
      text: 'Original reference image for lighting/occlusion guidance only:',
    });
    parts.push({
      inline_data: {
        data: referencePayload.buffer.toString('base64'),
        mime_type: referencePayload.mimeType || 'image/png',
      },
    });
  }

  parts.push({
    text: 'Transparent product source (identity lock, do not redesign):',
  });
  parts.push({
    inline_data: {
      data: productPayload.buffer.toString('base64'),
      mime_type: productPayload.mimeType || 'image/png',
    },
  });
  parts.push({ text: refinePrompt });

  const { response, requestUrl } = await postGeminiWithFallback({
    model: geminiModel,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        responseModalities: ['IMAGE'],
      },
    },
  });

  logInfo('Gemini', 'Refined pre-composited product placement', redactUrlSecrets(requestUrl));
  const extractedImage = extractGeminiImagePayload(response.data, 'image/png');
  if (!extractedImage?.base64) {
    throw new Error('Gemini returned no refined composite image data');
  }
  return {
    base64: extractedImage.base64,
    mimeType: extractedImage.mimeType || 'image/png',
  };
};

const SHOULD_REAPPLY_OVERLAY_AFTER_REFINE =
  String(process.env.REFERENCE_PLACEPRODUCT_REAPPLY_OVERLAY || 'false').toLowerCase() === 'true';

const normalizeReferencePlacementQualityGate = (parsed = {}) => {
  const toBool = (value, fallback = false) => {
    if (typeof value === 'boolean') {
      return value;
    }
    const raw = String(value || '').trim().toLowerCase();
    if (!raw) {
      return fallback;
    }
    if (raw === 'true' || raw === '1' || raw === 'yes') {
      return true;
    }
    if (raw === 'false' || raw === '0' || raw === 'no') {
      return false;
    }
    return fallback;
  };

  const scoreRaw = Number(parsed?.qualityScore ?? parsed?.score ?? parsed?.overallScore ?? 0);
  const qualityScore = Number.isFinite(scoreRaw)
    ? Math.max(0, Math.min(100, Math.round(scoreRaw)))
    : 0;

  const oldProductResidueLikely = toBool(
    parsed?.oldProductResidueLikely ?? parsed?.oldProductVisible ?? parsed?.oldProductLeak,
    false
  );
  const duplicateProductLikely = toBool(
    parsed?.duplicateProductLikely ?? parsed?.multipleProductsVisible ?? parsed?.duplicateHeroObject,
    false
  );
  const groundingWeakLikely = toBool(
    parsed?.groundingWeakLikely ?? parsed?.placementLooksPasted ?? parsed?.shadowGroundingWeak,
    false
  );
  const pass =
    toBool(parsed?.pass, qualityScore >= 72) &&
    !oldProductResidueLikely &&
    !duplicateProductLikely;

  const failureReasons = normalizeAnalyzeFailureReasons(
    parsed?.failureReasons || parsed?.reasons || parsed?.issues
  );

  return {
    pass,
    qualityScore,
    oldProductResidueLikely,
    duplicateProductLikely,
    groundingWeakLikely,
    failureReasons,
    summary: String(parsed?.summary || parsed?.notes || '').trim(),
  };
};

const runReferencePlacementQualityGateWithGemini = async ({
  stage = 'placed_composite',
  candidateImageBase64,
  candidateMimeType = 'image/png',
  referencePayload = null,
  productPayload = null,
  mergedReferencePlan = null,
  referencePlacement = null,
  promptText = '',
  requestedAspectRatio = '',
}) => {
  if (!candidateImageBase64) {
    return normalizeReferencePlacementQualityGate({ pass: true, qualityScore: 100 });
  }

  const geminiApiKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!geminiApiKey) {
    return normalizeReferencePlacementQualityGate({
      pass: true,
      qualityScore: 80,
      summary: 'Skipped quality gate because GEMINI_API_KEY is missing',
    });
  }

  const models = buildGeminiModelFallbackList([
    String(process.env.GEMINI_VISION_MODEL || '').trim(),
    String(process.env.GEMINI_TEXT_MODEL || '').trim(),
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    String(process.env.GEMINI_MODEL || '').trim(),
  ]);

  const placement = referencePlacement ? normalizeReferencePlacement(referencePlacement) : null;
  const sceneBlueprint = String(mergedReferencePlan?.sceneBlueprint || '').trim();
  const productAreaNotes = String(mergedReferencePlan?.productAreaNotes || '').trim();

  const gatePrompt =
    'You are a strict QA gate for reference-guided product-ad generation. ' +
    'Return STRICT JSON only with keys: pass, qualityScore, oldProductResidueLikely, duplicateProductLikely, groundingWeakLikely, failureReasons, summary. ' +
    `Current stage: ${String(stage || '').trim().toLowerCase() || 'placed_composite'}. ` +
    'Definitions: oldProductResidueLikely=true when original reference hero product or its remnants remain visible. ' +
    'duplicateProductLikely=true when two product bodies/containers or stacked product forms are visible. ' +
    'Treat any partial second cap/neck/body as duplicateProductLikely=true. ' +
    'groundingWeakLikely=true when product appears pasted, floating, or shadow/occlusion mismatch is obvious. ' +
    'qualityScore is 0-100 based on realism, cleanliness, and commercial quality. ' +
    'pass should be true only when single-product output is clean and visually integrated. ' +
    'If layering depth order around occluders is broken versus the reference context, mark pass=false.';

  const parts = [
    { text: gatePrompt },
    {
      text:
        `Scene lock hints: ${sceneBlueprint || 'n/a'}. ` +
        `Product area notes: ${productAreaNotes || 'n/a'}. ` +
        `${placement ? `Expected hero slot around center (${placement.centerX.toFixed(3)}, ${placement.centerY.toFixed(3)}), width ${placement.widthRatio.toFixed(3)}, height ${placement.heightRatio.toFixed(3)}. ` : ''}` +
        `${requestedAspectRatio ? `Aspect ratio: ${requestedAspectRatio}. ` : ''}` +
        `${promptText ? `User context: ${promptText}.` : ''}`,
    },
    { text: 'Candidate image to evaluate:' },
    {
      inline_data: {
        data: candidateImageBase64,
        mime_type: candidateMimeType || 'image/png',
      },
    },
  ];

  if (referencePayload?.buffer) {
    parts.push({ text: 'Original reference image (for residue/scene comparison):' });
    parts.push({
      inline_data: {
        data: referencePayload.buffer.toString('base64'),
        mime_type: referencePayload.mimeType || 'image/png',
      },
    });
  }

  if (productPayload?.buffer) {
    parts.push({ text: 'Uploaded product source image (identity lock):' });
    parts.push({
      inline_data: {
        data: productPayload.buffer.toString('base64'),
        mime_type: productPayload.mimeType || 'image/png',
      },
    });
  }

  const { response, model } = await postGeminiWithModelFallback({
    models,
    apiKey: geminiApiKey,
    payload: {
      contents: [
        {
          role: 'user',
          parts,
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    },
    purpose: 'Reference placement quality gate',
  });
  const raw = extractGeminiText(response.data).trim();
  const parsed = safeJsonParse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to parse reference placement quality gate JSON');
  }
  const normalized = normalizeReferencePlacementQualityGate(parsed);
  logInfo(
    'QualityGate',
    `stage=${stage}; model=${model}; pass=${normalized.pass}; score=${normalized.qualityScore}; residue=${normalized.oldProductResidueLikely}; duplicate=${normalized.duplicateProductLikely}; groundingWeak=${normalized.groundingWeakLikely}`
  );
  return normalized;
};

app.post('/api/reference/place-product', requireAuth, async (req, res) => {
  const recreatedImage = req.body?.recreatedImage || req.body?.backgroundImage;
  const productImage = req.body?.productImage;
  const referenceImage = req.body?.referenceImage;
  const promptText = String(req.body?.promptText || '').trim();
  const requestedAspectRatio = String(req.body?.requestedAspectRatio || '').trim();
  const rawScenePlan = req.body?.scenePlan && typeof req.body.scenePlan === 'object'
    ? req.body.scenePlan
    : null;

  if (!recreatedImage) {
    return res.status(400).json({ error: 'Recreated background image is required' });
  }
  if (!productImage) {
    return res.status(400).json({ error: 'Product image is required' });
  }

  const recreatedPayload = parseDataUrl(recreatedImage);
  if (!recreatedPayload?.buffer) {
    return res.status(400).json({ error: 'Invalid recreated background image format' });
  }
  const productPayload = parseDataUrl(productImage);
  if (!productPayload?.buffer) {
    return res.status(400).json({ error: 'Invalid product image format' });
  }
  const referencePayload = parseDataUrl(referenceImage);

  try {
    const recreatedMeta = await sharp(recreatedPayload.buffer).metadata();
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    let resolvedAspectRatio = requestedAspectRatio;
    if (!resolvedAspectRatio && recreatedMeta?.width && recreatedMeta?.height) {
      const w = Math.max(1, Math.round(recreatedMeta.width));
      const h = Math.max(1, Math.round(recreatedMeta.height));
      const divisor = gcd(w, h);
      resolvedAspectRatio = `${Math.round(w / divisor)}:${Math.round(h / divisor)}`;
    }
    const mergedReferencePlan = rawScenePlan ? normalizeReferenceScenePlan(rawScenePlan) : null;
    let resolvedPlacement = mergedReferencePlan?.placement
      ? normalizeReferencePlacement(mergedReferencePlan.placement)
      : null;
    if (!resolvedPlacement && referenceImage) {
      try {
        resolvedPlacement = await analyzeReferencePlacementHybrid({
          referenceImage,
          promptText,
        });
      } catch (placementAnalyzeError) {
        logWarn(
          'Reference',
          'Placement analysis fallback failed for /api/reference/place-product',
          placementAnalyzeError.message || 'Unknown error'
        );
      }
    }

    let backgroundBase64 = recreatedPayload.buffer.toString('base64');
    let recreatedBackgroundQualityGate = null;
    if (referencePayload?.buffer && mergedReferencePlan) {
      try {
        recreatedBackgroundQualityGate = await runReferencePlacementQualityGateWithGemini({
          stage: 'recreated_background',
          candidateImageBase64: backgroundBase64,
          candidateMimeType: recreatedPayload.mimeType || 'image/png',
          referencePayload,
          mergedReferencePlan,
          referencePlacement: resolvedPlacement,
          promptText,
          requestedAspectRatio: resolvedAspectRatio,
        });

        if (recreatedBackgroundQualityGate.oldProductResidueLikely) {
          const promptBundle = buildReferencePromptBundleFromMergedPlan({
            mergedPlan: mergedReferencePlan,
            promptText,
            requestedAspectRatio: resolvedAspectRatio,
            generationVariant: 'reference_exact',
          });
          const recreatedBackground = await recreateReferenceBackgroundWithGemini({
            referencePayload,
            promptBundle,
            promptText,
            requestedAspectRatio: resolvedAspectRatio,
          });
          backgroundBase64 = recreatedBackground.base64;
          recreatedBackgroundQualityGate = await runReferencePlacementQualityGateWithGemini({
            stage: 'recreated_background_retry',
            candidateImageBase64: backgroundBase64,
            candidateMimeType: recreatedBackground.mimeType || 'image/png',
            referencePayload,
            mergedReferencePlan,
            referencePlacement: resolvedPlacement,
            promptText,
            requestedAspectRatio: resolvedAspectRatio,
          });
        }
      } catch (recreateQualityError) {
        logWarn(
          'QualityGate',
          'Recreated background quality gate failed; continuing with provided background',
          recreateQualityError.message || 'Unknown error'
        );
      }
    }

    try {
      const draftBase64 = await compositeProductOntoBackground({
        backgroundBase64,
        sourceBuffer: productPayload.buffer,
        referencePlacement: resolvedPlacement || undefined,
      });
      const refined = await refinePlacedProductCompositeWithGemini({
        draftBase64,
        productPayload,
        referencePayload,
        referencePlacement: resolvedPlacement,
        mergedReferencePlan,
        promptText,
        requestedAspectRatio: resolvedAspectRatio,
      });
      let finalBase64 = refined?.base64 || draftBase64;
      if (
        SHOULD_REAPPLY_OVERLAY_AFTER_REFINE &&
        refined?.base64 &&
        resolvedPlacement &&
        !resolvedPlacement.preserveForegroundOccluders
      ) {
        finalBase64 = await compositeProductOntoBackground({
          backgroundBase64: finalBase64,
          sourceBuffer: productPayload.buffer,
          referencePlacement: resolvedPlacement,
        });
      }

      let finalQualityGate = null;
      try {
        finalQualityGate = await runReferencePlacementQualityGateWithGemini({
          stage: 'placed_composite',
          candidateImageBase64: finalBase64,
          candidateMimeType: refined?.mimeType || 'image/png',
          referencePayload,
          productPayload,
          mergedReferencePlan,
          referencePlacement: resolvedPlacement,
          promptText,
          requestedAspectRatio: resolvedAspectRatio,
        });

        const shouldRetryStrict =
          finalQualityGate &&
          (
            finalQualityGate.oldProductResidueLikely ||
            finalQualityGate.duplicateProductLikely ||
            finalQualityGate.groundingWeakLikely
          );
        if (shouldRetryStrict) {
          const strictDraftBase64 = await compositeProductOntoBackground({
            backgroundBase64,
            sourceBuffer: productPayload.buffer,
            referencePlacement: resolvedPlacement || undefined,
            scaleMultiplier: 0.96,
          });
          const strictRefined = await refinePlacedProductCompositeWithGemini({
            draftBase64: strictDraftBase64,
            productPayload,
            referencePayload,
            referencePlacement: resolvedPlacement,
            mergedReferencePlan,
            promptText,
            requestedAspectRatio: resolvedAspectRatio,
            strictProfile: true,
          });
          let strictFinalBase64 = strictRefined?.base64 || strictDraftBase64;
          if (
            SHOULD_REAPPLY_OVERLAY_AFTER_REFINE &&
            strictRefined?.base64 &&
            resolvedPlacement &&
            !resolvedPlacement.preserveForegroundOccluders
          ) {
            strictFinalBase64 = await compositeProductOntoBackground({
              backgroundBase64: strictFinalBase64,
              sourceBuffer: productPayload.buffer,
              referencePlacement: resolvedPlacement,
            });
          }

          const strictQualityGate = await runReferencePlacementQualityGateWithGemini({
            stage: 'placed_composite_strict_retry',
            candidateImageBase64: strictFinalBase64,
            candidateMimeType: strictRefined?.mimeType || 'image/png',
            referencePayload,
            productPayload,
            mergedReferencePlan,
            referencePlacement: resolvedPlacement,
            promptText,
            requestedAspectRatio: resolvedAspectRatio,
          });

          const strictIsBetter =
            strictQualityGate.pass ||
            Number(strictQualityGate.qualityScore || 0) > Number(finalQualityGate.qualityScore || 0);
          if (strictIsBetter) {
            finalBase64 = strictFinalBase64;
            finalQualityGate = strictQualityGate;
          }
        }
      } catch (qualityGateError) {
        logWarn(
          'QualityGate',
          'Final placement quality gate failed; returning best-effort deterministic output',
          qualityGateError.message || 'Unknown error'
        );
      }

      return res.json({
        imageUrl: `data:${refined?.mimeType || 'image/png'};base64,${finalBase64}`,
        qualityGate: finalQualityGate || undefined,
        recreatedBackgroundQualityGate: recreatedBackgroundQualityGate || undefined,
      });
    } catch (deterministicPipelineError) {
      logWarn(
        'Reference',
        'Deterministic placement pipeline failed, falling back to Gemini scene placement',
        deterministicPipelineError.message || 'Unknown error'
      );
    }

    const placed = await placeProductIntoSceneWithGemini({
      backgroundBase64,
      productPayload,
      referencePayload,
      referencePlacement: resolvedPlacement,
      mergedReferencePlan,
      promptText,
      requestedAspectRatio: resolvedAspectRatio,
      lockBackgroundOutsidePlacement: false,
      autoPlacement: !resolvedPlacement,
    });

    return res.json({
      imageUrl: `data:${placed.mimeType || 'image/png'};base64,${placed.base64}`,
    });
  } catch (error) {
    const errorData = error.response?.data;
    const geminiDetails = error?.details || error?.cause?.details || null;
    const errorDetails =
      errorData?.error?.message ||
      errorData?.error ||
      geminiDetails?.data?.error?.message ||
      geminiDetails?.data?.error ||
      errorData ||
      error.message;
    const errorTextRaw =
      typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails);
    const errorText =
      geminiDetails?.attempted && !String(errorTextRaw || '').includes('Gemini endpoints:')
        ? `${errorTextRaw} (Gemini endpoints: ${geminiDetails.attempted})`
        : errorTextRaw;
    console.error('Error in /api/reference/place-product:', errorText);
    return res.status(500).json({
      error: 'Product placement failed',
      details: errorText,
    });
  }
});

const invokeGenerateApiLocally = async ({
  prompt,
  productImage,
  referenceImage,
  referenceMode,
  logoImage,
  generationVariant = '',
  brandTextOverlay = '',
  source = '',
  skipCaptionGeneration = false,
  onProgress = null,
}) => {
  let statusCode = 0;
  let payload = {};

  const req = {
    body: {
      prompt,
      productImage,
      referenceImage,
      referenceMode,
      logoImage,
      generationVariant,
      brandTextOverlay,
      source,
      skipCaptionGeneration,
    },
    user: null,
    headers: {},
    progressReporter: typeof onProgress === 'function' ? onProgress : null,
  };
  const res = {
    status(code) {
      statusCode = Number(code) || 500;
      return this;
    },
    json(data) {
      payload = data && typeof data === 'object' ? data : {};
      if (statusCode < 100) {
        statusCode = 200;
      }
      return this;
    },
  };

  try {
    await handleGenerateApi(req, res);
  } catch (error) {
    return {
      ok: false,
      status: 500,
      payload: {
        error: error.message || 'Generation failed',
      },
    };
  }

  return {
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    payload,
  };
};

const resolvePipelineNameFromGenerationFlow = (generationFlow = '', referenceMode = '') => {
  const flow = String(generationFlow || '').trim().toLowerCase();
  const mode = String(referenceMode || '').trim().toLowerCase();
  if (flow.startsWith('openai') || mode === 'openai') {
    return PIPELINE_NAME_OPENAI_IMAGE;
  }
  if (flow.includes('reference_guided') || mode === 'overlay') {
    return PIPELINE_NAME_GEMINI_REFERENCE_GUIDED;
  }
  return PIPELINE_NAME_GEMINI_EDIT;
};

const handleGenerateApi = async (req, res) => {
  const {
    prompt,
    productImage,
    referenceImage,
    referenceMode,
    logoImage,
    generationVariant,
    brandTextOverlay,
    source,
    skipCaptionGeneration,
    strictReferenceLock,
    forceGeminiPlacementOnly,
  } = req.body;
  const projectApiPolicyContext =
    req?.projectApiPolicy && typeof req.projectApiPolicy === 'object'
      ? req.projectApiPolicy
      : null;
  const hasUserAccountContext = Boolean(req.user?.id);
  const hasWebStyleGenerationContext = hasUserAccountContext || Boolean(req.projectApi?.projectId);
  const shouldEnforceCreditLimit = hasUserAccountContext && !isUsageLimitExemptUser(req.user);
  const requestSource = String(source || '').toLowerCase();
  const normalizedGenerationVariant = String(generationVariant || '').trim().toLowerCase();
  const shouldForceGeminiPlacementOnly =
    forceGeminiPlacementOnly === true ||
    String(forceGeminiPlacementOnly || '').toLowerCase() === 'true' ||
    String(forceGeminiPlacementOnly || '') === '1';
  const requestedBrandTextOverlay = normalizeBrandOverlayText(brandTextOverlay || '');
  const shouldSkipCaptionGeneration =
    skipCaptionGeneration === true ||
    String(skipCaptionGeneration || '').toLowerCase() === 'true' ||
    requestSource === 'telegram' ||
    requestSource === 'telegram_bot';
  let creditReserved = false;
  let remainingCredits = null;

  const hasPrompt = String(prompt || '').trim().length > 0;
  const hasReferenceInput = typeof referenceImage === 'string' && referenceImage.startsWith('data:');
  if (!hasPrompt && !hasReferenceInput) {
    return res.status(400).json({ error: 'Prompt is required when reference image is not provided' });
  }

  const progressReporter = typeof req?.progressReporter === 'function' ? req.progressReporter : null;
  const referenceProgressState = {
    promptGenerated: false,
    recreateScene: false,
    addProduct: false,
  };
  const emitReferenceProgress = async (stepKey) => {
    if (!progressReporter) return;
    const map = {
      promptGenerated: {
        stateKey: 'promptGenerated',
        event: 'prompt_generated',
        message: 'Step 1/3: We are generating prompt from reference scene analysis...',
      },
      recreateScene: {
        stateKey: 'recreateScene',
        event: 'recreate_scene',
        message: 'Step 2/3: We are recreating clean reference scene...',
      },
      addProduct: {
        stateKey: 'addProduct',
        event: 'add_product',
        message: 'Step 3/3: We are adding product and running quality checks...',
      },
    };
    const meta = map[String(stepKey || '')];
    if (!meta) return;
    if (referenceProgressState[meta.stateKey]) return;
    referenceProgressState[meta.stateKey] = true;
    try {
      await progressReporter(meta.event, meta.message);
    } catch (progressError) {
      console.warn('[API /generate] Progress reporter failed:', progressError.message);
    }
  };

  try {
    const hasProductImage = typeof productImage === 'string' && productImage.startsWith('data:');
    let productPayload = hasProductImage ? parseDataUrl(productImage) : null;
    const hasUploadedReferenceImage = typeof referenceImage === 'string' && referenceImage.startsWith('data:');
    const uploadedReferencePayload = hasUploadedReferenceImage ? parseDataUrl(referenceImage) : null;
    let sourceImageDataUrl = hasProductImage ? productImage : (hasUploadedReferenceImage ? referenceImage : '');
    let sourcePayload = hasProductImage ? productPayload : uploadedReferencePayload;
    let hasSourceImage = Boolean(sourceImageDataUrl && sourcePayload);
    const hasBackgroundReferenceImage = hasProductImage && hasUploadedReferenceImage;
    const strictReferenceLockRequested =
      !shouldForceGeminiPlacementOnly &&
      (
        strictReferenceLock === true ||
        String(strictReferenceLock || '').toLowerCase() === 'true' ||
        String(strictReferenceLock || '') === '1'
      );
    const strictReferenceLockEnabled = strictReferenceLockRequested && hasBackgroundReferenceImage;
    if (strictReferenceLockRequested && !hasBackgroundReferenceImage) {
      logWarn('StrictLock', 'Requested but ignored because product or reference image is missing', '');
    } else if (strictReferenceLockEnabled) {
      logInfo('StrictLock', 'Enabled for this generation request');
    }
    if (hasBackgroundReferenceImage && hasProductImage) {
      try {
        const productInspection = await inspectImageDataUrl(productImage);
        const cutoutCandidate = productInspection.hasTransparentPixels
          ? productImage
          : await extractProductCutoutForComposite(productImage);
        if (productInspection.hasTransparentPixels) {
          logInfo('Cutout', 'Using uploaded transparent product cutout as-is');
        }
        const cutoutInspection = await inspectImageDataUrl(cutoutCandidate);
        if (cutoutInspection.hasTransparentPixels) {
          sourceImageDataUrl = cutoutCandidate;
          sourcePayload = parseDataUrl(cutoutCandidate);
          productPayload = sourcePayload;
          hasSourceImage = Boolean(sourceImageDataUrl && sourcePayload);
          logInfo('Cutout', 'Prepared product cutout for reference-based compositing');
        } else if (!productInspection.hasTransparentPixels) {
          const fallbackCutoutImage = await removeBackgroundImageData(productImage, 'gemini');
          const fallbackCutoutInspection = await inspectImageDataUrl(fallbackCutoutImage);
          if (fallbackCutoutInspection.hasTransparentPixels) {
            sourceImageDataUrl = fallbackCutoutImage;
            sourcePayload = parseDataUrl(fallbackCutoutImage);
            productPayload = sourcePayload;
            hasSourceImage = Boolean(sourceImageDataUrl && sourcePayload);
            logInfo('Cutout', 'Fallback background removal enabled reference-based compositing');
          }
        }
      } catch (autoCutoutError) {
        logWarn('Cutout', 'Auto background removal for reference compositing failed', autoCutoutError.message);
      }
    }
    const requestedCtaText = extractRequestedCtaFromPrompt(prompt);
    const shouldForceCtaOverlay = String(process.env.TELEGRAM_FORCE_CTA_OVERLAY || 'true').toLowerCase() !== 'false';
    const shouldSuppressModelCtaText =
      !hasWebStyleGenerationContext &&
      shouldForceCtaOverlay &&
      requestedCtaText &&
      requestedCtaText !== 'None';
    const promptForModel = shouldSuppressModelCtaText
      ? (stripCtaInstructionsFromPrompt(prompt) || String(prompt || ''))
      : String(prompt || '');
    const requestedAspectRatio =
      extractRequestedAspectRatioFromPrompt(promptForModel) ||
      normalizeAnalyzeAspectRatio(
        req.body?.aspectRatio ||
        req.body?.aspect_ratio ||
        req.body?.format ||
        req.body?.ratio
      ) ||
      '1:1';
    const targetCanvas = getCanvasDimensionsForAspectRatio(requestedAspectRatio);
    if (hasProductImage && !productPayload) {
      return res.status(400).json({ error: 'Invalid product image format' });
    }
    if (hasUploadedReferenceImage && !uploadedReferencePayload) {
      return res.status(400).json({ error: 'Invalid reference image format' });
    }
    const hasLogoImage = typeof logoImage === 'string' && logoImage.startsWith('data:');
    const logoPayload = hasLogoImage ? parseDataUrl(logoImage) : null;
    if (hasLogoImage && !logoPayload) {
      return res.status(400).json({ error: 'Invalid logo image format' });
    }

    if (shouldEnforceCreditLimit) {
      const reservedCredit = await pool.query(
        `
          UPDATE users
          SET credits = credits - 1
          WHERE id = $1
            AND credits > 0
          RETURNING credits
        `,
        [req.user.id]
      );
      if (!reservedCredit.rowCount) {
        return res.status(402).json({ error: 'No credits remaining. Please upgrade your plan.' });
      }
      creditReserved = true;
      remainingCredits = Number(reservedCredit.rows[0]?.credits ?? 0);
    }

    const useFastReferencePipeline =
      String(process.env.WEB_FAST_REFERENCE_PIPELINE || 'false').toLowerCase() === 'true';

    if (
      useFastReferencePipeline &&
      hasBackgroundReferenceImage &&
      hasProductImage &&
      sourcePayload?.buffer &&
      uploadedReferencePayload?.buffer
    ) {
      await emitReferenceProgress('promptGenerated');
      const resolvedAspectRatio =
        requestedAspectRatio ||
        await inferAspectRatioFromBuffer(uploadedReferencePayload.buffer, '1:1');

      const geminiPlan = await analyzeReferenceScenePlanWithGemini({
        referenceImage,
        promptText: promptForModel,
        requestedAspectRatio: resolvedAspectRatio,
      });
      const promptBundle = buildReferencePromptBundleFromMergedPlan({
        mergedPlan: geminiPlan,
        promptText: promptForModel,
        requestedAspectRatio: resolvedAspectRatio,
        generationVariant: normalizedGenerationVariant || 'reference_exact',
      });

      await emitReferenceProgress('recreateScene');
      const recreatedBackground = await recreateReferenceBackgroundWithGemini({
        referencePayload: uploadedReferencePayload,
        promptBundle,
        promptText: promptForModel,
        requestedAspectRatio: resolvedAspectRatio,
      });

      await emitReferenceProgress('addProduct');
      const placedProduct = await placeProductIntoSceneWithGemini({
        backgroundBase64: recreatedBackground.base64,
        productPayload: sourcePayload,
        referencePayload: uploadedReferencePayload,
        referencePlacement: geminiPlan?.placement || null,
        mergedReferencePlan: geminiPlan,
        promptText: promptForModel,
        requestedAspectRatio: resolvedAspectRatio,
        lockBackgroundOutsidePlacement: false,
        autoPlacement: true,
      });

      return res.json({
        caption: '',
        editInstruction: undefined,
        captionType: 'caption',
        generationVariant: normalizedGenerationVariant || undefined,
        usedReferenceImage: true,
        referenceMode: 'overlay',
        generationFlow: 'reference_guided_fast',
        pipelineName: resolvePipelineNameFromGenerationFlow('reference_guided_fast', 'overlay'),
        requestedPipeline: projectApiPolicyContext?.requestedPipeline || undefined,
        effectivePipeline:
          projectApiPolicyContext?.effectivePipeline ||
          resolvePipelineNameFromGenerationFlow('reference_guided_fast', 'overlay'),
        pipelineOverrideRejected: projectApiPolicyContext?.overrideRejected === true || undefined,
        pipelineRejectionReason: projectApiPolicyContext?.rejectionReason || undefined,
        strictReferenceLock: undefined,
        backgroundPrompt: promptBundle.backgroundPrompt || undefined,
        imageUrl: `data:${placedProduct.mimeType || 'image/png'};base64,${placedProduct.base64}`,
        recreatedBackgroundImageUrl: `data:${recreatedBackground.mimeType || 'image/png'};base64,${recreatedBackground.base64}`,
        remainingCredits,
      });
    }

    const logoGuardInstruction = logoPayload
      ? ' Do not add any logos, brand marks, or watermarks. If any text is added, limit it to the requested CTA only. Keep the top-right corner visually quiet with uninterrupted natural background for a later transparent logo overlay. Do not create any white box, solid patch, panel, card, badge, label plate, or placeholder area there.'
      : '';
    const ctaTextGuardInstruction = shouldSuppressModelCtaText
      ? ' Do not add any text, typography, labels, call-to-action words, or button text in the generated image.'
      : '';
    const brandTextGuardInstruction = requestedBrandTextOverlay
      ? ' Do not add brand-name text or decorative typography in the generated image. Keep the chosen text-overlay area on natural uninterrupted background, not inside any white box, panel, card, badge, or placeholder patch.'
      : '';
    const strayTextGuardInstruction =
      ' Do not render random characters, gibberish letters, watermark-like marks, signatures, stamps, or floating text artifacts anywhere in the frame. Keep only natural printed text already present on the original product label.';
    const logoCornerInstruction = logoPayload
      ? ' Keep the top-right corner visually quiet with natural uninterrupted background for a later transparent logo overlay. Do not create any white box, solid patch, panel, card, badge, label plate, reserved block, or placeholder area there.'
      : ' Keep the center area visually quiet with natural uninterrupted background for a later logo overlay. Do not create any white box, solid patch, panel, card, badge, reserved block, or placeholder area there.';

    const allowedReferenceModes = new Set(['auto', 'edit', 'overlay', 'openai']);
    const normalizeMode = (value) => {
      if (!value) {
        return '';
      }
      const normalized = String(value).toLowerCase();
      return normalized === 'chatgpt' ? 'openai' : normalized;
    };
    const requestedMode = normalizeMode(referenceMode);
    const referenceModeEnv = normalizeMode(process.env.REFERENCE_MODE || 'edit');
    const resolvedModeInput = allowedReferenceModes.has(requestedMode)
      ? requestedMode
      : allowedReferenceModes.has(referenceModeEnv)
        ? referenceModeEnv
        : 'edit';
    let resolvedReferenceMode = hasSourceImage ? 'edit' : 'none';
    let generationFlow = hasBackgroundReferenceImage ? 'reference_guided' : 'gemini_edit_only';
    let referencePlacement = null;
    let mergedReferenceAnalysis = null;

    if (hasBackgroundReferenceImage && hasSourceImage) {
      if (resolvedModeInput === 'openai') {
        resolvedReferenceMode = 'openai';
        generationFlow = 'openai_reference_edit';
      } else if (resolvedModeInput === 'edit') {
        resolvedReferenceMode = 'edit';
        generationFlow = 'gemini_reference_edit';
      } else {
        // For auto/overlay we keep the deterministic reference-guided pipeline.
        resolvedReferenceMode = 'overlay';
        generationFlow = 'reference_guided';
      }
    } else if (hasSourceImage && sourcePayload) {
      if (resolvedModeInput === 'openai') {
        resolvedReferenceMode = 'openai';
        generationFlow = 'openai_edit_only';
      } else if (resolvedModeInput === 'overlay') {
        resolvedReferenceMode = 'overlay';
        generationFlow = 'gemini_overlay_only';
      } else {
        // No reference image: auto mode should stay Gemini edit-only for consistent behavior.
        resolvedReferenceMode = 'edit';
        generationFlow = 'gemini_edit_only';
      }
    } else if (resolvedModeInput === 'openai') {
      resolvedReferenceMode = 'openai';
      generationFlow = 'openai_text_only';
    } else if (!hasSourceImage) {
      generationFlow = 'gemini_text_only';
    }

    const shouldSuppressCaptionOutput = shouldSkipCaptionGeneration || (hasBackgroundReferenceImage && resolvedReferenceMode === 'overlay');

    // Step 1: Build caption/edit instruction.
    let generatedCaption = '';
    let editInstruction = '';
    let backgroundPrompt = '';
    let referencePromptBundle = null;
    const backgroundReferenceGuideInstruction = hasBackgroundReferenceImage
      ? ' Use the optional reference image as the primary guide for the background, environment, palette, texture, and lighting. Match that scene closely while keeping the exact product identity from the product image intact.'
      : '';
    const openaiModel = process.env.OPENAI_MODEL || 'gpt-4o';
    const visionUserContent = hasSourceImage
      ? [
          { type: 'text', text: `User prompt: ${promptForModel}` },
          { type: 'text', text: 'Product image:' },
          { type: 'image_url', image_url: { url: sourceImageDataUrl } },
          ...(hasBackgroundReferenceImage
            ? [
                { type: 'text', text: 'Optional background reference image:' },
                { type: 'image_url', image_url: { url: referenceImage } },
              ]
            : []),
        ]
      : null;

    if (hasBackgroundReferenceImage && resolvedReferenceMode === 'overlay') {
      await emitReferenceProgress('promptGenerated');
      if (strictReferenceLockEnabled) {
        try {
          referencePlacement = await analyzeReferencePlacementWithGemini({
            referenceImage,
            promptText: promptForModel,
          });
          logInfo(
            'StrictLock',
            `Placement analyzed with Gemini for strict mode (center=${referencePlacement?.centerX?.toFixed?.(3) || 'n/a'}, ${referencePlacement?.centerY?.toFixed?.(3) || 'n/a'})`
          );
        } catch (placementError) {
          logWarn('StrictLock', 'Gemini placement analysis failed in strict mode; using default placement', placementError.message);
        }
        referencePromptBundle = normalizeReferenceGenerationPromptBundle({
          backgroundPrompt: promptForModel,
          scenePrompt: promptForModel,
          displayText: promptForModel,
        });
        backgroundPrompt = promptForModel;
        generatedCaption = promptForModel;
      } else {
        try {
          const geminiPlan = await analyzeReferenceScenePlanWithGemini({
            referenceImage,
            promptText: promptForModel,
            requestedAspectRatio,
          });
          const geminiPromptBundle = buildReferencePromptBundleFromMergedPlan({
            mergedPlan: geminiPlan,
            promptText: promptForModel,
            requestedAspectRatio,
            generationVariant: normalizedGenerationVariant,
          });
          mergedReferenceAnalysis = {
            mergedPlan: geminiPlan,
            openAiPlan: null,
            geminiPlan,
            promptBundle: geminiPromptBundle,
          };
          try {
            referencePlacement = await analyzeReferencePlacementWithGemini({
              referenceImage,
              promptText: promptForModel,
            });
          } catch (geminiPlacementError) {
            logWarn('Placement', 'Gemini dedicated placement analysis failed; using Gemini scene-plan placement', geminiPlacementError.message);
            referencePlacement = mergedReferenceAnalysis?.mergedPlan?.placement || referencePlacement;
          }
          referencePromptBundle = mergedReferenceAnalysis?.promptBundle || null;
          backgroundPrompt =
            referencePromptBundle.backgroundPrompt ||
            referencePromptBundle.scenePrompt ||
            promptForModel;
          generatedCaption = referencePromptBundle.displayText || '';
          logInfo(
            'Prompt',
            'Using Gemini-only reference scene analysis',
            `placement=(${referencePlacement?.centerX?.toFixed?.(3) || 'n/a'}, ${referencePlacement?.centerY?.toFixed?.(3) || 'n/a'}) rot=${referencePlacement?.rotationDeg ?? 'n/a'}`
          );
        } catch (referencePromptError) {
          logWarn('Prompt', 'Gemini reference scene analysis failed; using prompt-only fallback', referencePromptError.message);
          try {
            referencePlacement = await analyzeReferencePlacementWithGemini({
              referenceImage,
              promptText: promptForModel,
            });
          } catch (placementError) {
            logWarn('Placement', 'Gemini reference placement analysis failed', placementError.message);
          }
          referencePromptBundle = normalizeReferenceGenerationPromptBundle({
            backgroundPrompt: promptForModel,
            scenePrompt: promptForModel,
            displayText: promptForModel,
          });
          backgroundPrompt = promptForModel;
          generatedCaption = promptForModel;
        }
      }
    }

    if (referencePromptBundle) {
      // Reference flow now uses the generated prompt bundle directly instead of a separate caption step.
    } else if (shouldSkipCaptionGeneration) {
      generatedCaption = promptForModel;
      if (hasSourceImage && resolvedReferenceMode === 'overlay') {
        backgroundPrompt = promptForModel;
      }
      if (hasSourceImage && resolvedReferenceMode !== 'overlay') {
        editInstruction = `Edit the provided product image to reflect: ${promptForModel}${backgroundReferenceGuideInstruction}`;
      }
      console.log(`[Caption] Skipped for source=${requestSource || 'unknown'}`);
    } else {
      console.log('Generating caption with OpenAI...');
      try {
        if (hasSourceImage && resolvedReferenceMode === 'overlay') {
          const completion = await openai.chat.completions.create({
            messages: [
              {
                role: "system",
                content:
                  "You are a creative assistant. Return STRICT JSON with keys: caption, backgroundPrompt. " +
                  "caption: short descriptive caption of the final composite image (1-2 sentences), do NOT copy the user's prompt, avoid imperative verbs like 'create' or 'add'. " +
                  "backgroundPrompt: prompt to generate ONLY the background scene, without any logos or text overlays. " +
                  "Use the product image as the subject. If an optional background reference image is provided, treat it as the primary background reference and match its mood, palette, texture, depth, and composition closely. Do NOT include logos in the background. " +
                  "No extra keys, no markdown."
              },
              { role: "user", content: visionUserContent }
            ],
            response_format: { type: "json_object" },
            model: openaiModel,
          });

          const raw = getMessageText(completion.choices?.[0]?.message).trim();
          try {
            const parsed = JSON.parse(raw);
            generatedCaption = String(parsed.caption || '').trim();
            backgroundPrompt = String(parsed.backgroundPrompt || '').trim();
          } catch (parseError) {
            backgroundPrompt = raw;
          }

          if (!generatedCaption) {
            generatedCaption = promptForModel;
          }
          if (!backgroundPrompt) {
            backgroundPrompt = promptForModel;
          }
        } else if (hasSourceImage) {
          const completion = await openai.chat.completions.create({
            messages: [
              {
                role: "system",
                content:
                  "You are a creative assistant. Return STRICT JSON with keys: caption, editInstruction. " +
                  "caption: short descriptive caption of the desired final image (1-2 sentences), do NOT copy the user's prompt. " +
                  "editInstruction: concise instruction to edit the provided product image while preserving the product, framing, and composition. " +
                  "Always include a clear background change or addition that matches the user's prompt (if background is plain/transparent, replace it). " +
                  "If an optional background reference image is provided, use it only to guide the background and overall mood. " +
                  "Use visible details from the product image when describing edits. " +
                  "No extra keys, no markdown."
              },
              { role: "user", content: visionUserContent }
            ],
            response_format: { type: "json_object" },
            model: openaiModel,
          });

          const raw = getMessageText(completion.choices?.[0]?.message).trim();
          try {
            const parsed = JSON.parse(raw);
            generatedCaption = String(parsed.caption || '').trim();
            editInstruction = String(parsed.editInstruction || parsed.instruction || '').trim();
          } catch (parseError) {
            editInstruction = raw;
          }

          if (!generatedCaption) {
            generatedCaption = promptForModel;
          }
          if (!editInstruction) {
            editInstruction = `Edit the provided product image to reflect: ${promptForModel}${backgroundReferenceGuideInstruction}`;
          }
        } else {
          const completion = await openai.chat.completions.create({
            messages: [
              {
                role: "system",
                content: "You are a creative assistant. improvements user prompt for image generation. Create a detailed, vivid caption based on the user's input. Output ONLY the caption, no explanations."
              },
              { role: "user", content: promptForModel }
            ],
            model: openaiModel,
          });

          generatedCaption = getMessageText(completion.choices?.[0]?.message).trim();
        }

        if (!generatedCaption) {
          generatedCaption = promptForModel;
        }
        if (isCaptionWeak(generatedCaption, promptForModel)) {
          try {
            const fallbackCompletion = await openai.chat.completions.create({
              messages: [
                {
                  role: "system",
                  content:
                    "Write a short marketing caption (5-12 words) describing the final image. " +
                    "Do not repeat the user's prompt verbatim and avoid imperative verbs."
                },
                {
                  role: "user",
                  content: backgroundPrompt
                    ? `User prompt: ${promptForModel}\nBackground intent: ${backgroundPrompt}`
                    : `User prompt: ${promptForModel}`
                }
              ],
              model: openaiModel,
            });
            const fallbackCaption = getMessageText(fallbackCompletion.choices?.[0]?.message).trim();
            if (fallbackCaption) {
              generatedCaption = fallbackCaption;
            }
          } catch (fallbackError) {
            console.warn('Fallback caption generation failed:', fallbackError.message);
          }
        }
      } catch (captionError) {
        console.warn('OpenAI caption step failed; trying Gemini fallback:', captionError.message);
        const geminiCaption = await generateGeminiCaptionFallback({
          promptForModel,
          backgroundPrompt,
        });
        generatedCaption = geminiCaption || promptForModel;
        if (hasSourceImage && resolvedReferenceMode === 'overlay') {
          backgroundPrompt = backgroundPrompt || promptForModel;
        }
        if (hasSourceImage && resolvedReferenceMode !== 'overlay') {
          editInstruction = editInstruction || `Edit the provided product image to reflect: ${promptForModel}${backgroundReferenceGuideInstruction}`;
        }
      }
    }
    if (generatedCaption && !shouldSuppressCaptionOutput) {
      logInfo('Caption', summarizeForTerminal(generatedCaption, 140));
    }
    if (backgroundPrompt) {
      logInfo('Background', summarizeForTerminal(backgroundPrompt, 240));
    }
    if (editInstruction) {
      logInfo('Edit', summarizeForTerminal(editInstruction, 180));
    }

    const shouldUseOpenAIImages = resolvedModeInput === 'openai';
    const shouldUseGeminiSceneEditPlacement =
      shouldForceGeminiPlacementOnly ||
      (
        !strictReferenceLockEnabled &&
        String(process.env.REFERENCE_OVERLAY_USE_GEMINI_SCENE_EDIT || 'true').toLowerCase() !== 'false'
      );

    const shouldUseAiOverlayRefinement =
      !strictReferenceLockEnabled &&
      String(process.env.REFERENCE_OVERLAY_ENABLE_AI_REFINE || 'false').toLowerCase() === 'true';

    const refineCompositeWithAi = async (draftBase64) => {
      if (!shouldUseAiOverlayRefinement) {
        return draftBase64;
      }
      const gModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
      const gKey = process.env.GEMINI_API_KEY;
      const refPrompt =
        `Add realistic contact shadows, ambient occlusion, and lighting to this composite. ` +
        `CRITICAL: Do NOT change the size, scale, position, rotation, or core shape of the product. ` +
        `Do NOT generate a second product or duplicate the item. ` +
        `Only build the shadows, edge blending, and subtle reflections needed to ground the already-placed product naturally in the scene. ` +
        `Do NOT redraw the background layout. ` +
        `${referencePlacement?.supportSurface ? `The product must remain resting on the ${referencePlacement.supportSurface}. ` : ''}` +
        `${referencePlacement?.contactEdge ? `Preserve contact along the ${referencePlacement.contactEdge}. ` : ''}` +
        `${referencePlacement?.preserveForegroundOccluders ? 'Keep any small foreground props already overlapping the product area, such as sunglasses or leaves, and let them naturally remain on top of the new product if visible. ' : ''}` +
        `Keep the result crisp and photorealistic. Aspect ratio: ${requestedAspectRatio || '1:1'}. ` +
        `${backgroundPrompt ? `Scene intent: ${backgroundPrompt}.` : ''}`;
      
      const { response, requestUrl: rUrl } = await postGeminiWithFallback({
        model: gModel, apiKey: gKey,
        payload: {
          contents: [{ role: 'user', parts: [
            { text: 'Pre-composited draft with the new product already placed:' },
            { inline_data: { data: draftBase64, mime_type: 'image/png' } },
            { text: refPrompt }] 
          }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }
      });
      console.log(`[Gemini] General composite refined via ${rUrl}`);
      const ext = extractGeminiImagePayload(response.data, 'image/png');
      return ext?.base64 || draftBase64;
    };

    // Step 2: Generate Image
    logInfo('Generate', `Generating image with ${shouldUseOpenAIImages ? 'OpenAI' : 'Gemini'}`);
    if (hasBackgroundReferenceImage && resolvedReferenceMode === 'overlay') {
      await emitReferenceProgress('recreateScene');
    }
    const effectiveInstruction = hasSourceImage
      ? `Edit the provided product image. Preserve the product, shapes, and layout unless instructed otherwise. Make changes clearly visible and do not return an unchanged image. Replace or add a rich background that matches the user's prompt while keeping the product crisp and centered.${backgroundReferenceGuideInstruction} ${editInstruction || generatedCaption || promptForModel}${strayTextGuardInstruction}${logoGuardInstruction}${brandTextGuardInstruction}${ctaTextGuardInstruction}`
      : `${generatedCaption || promptForModel}${strayTextGuardInstruction}${logoGuardInstruction}${brandTextGuardInstruction}${ctaTextGuardInstruction}`;

    let imageBase64 = null;
    let imageMimeType = process.env.GEMINI_IMAGE_MIME || 'image/png';
    let recreatedBackgroundBase64 = null;
    let recreatedBackgroundMimeType = 'image/png';

    try {
      if (hasBackgroundReferenceImage && resolvedReferenceMode === 'overlay' && uploadedReferencePayload) {
        try {
          const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
          const geminiApiKey = process.env.GEMINI_API_KEY;
          const isExactReferenceVariant = normalizedGenerationVariant.startsWith('reference_exact');
          const shouldUseRawExactReferenceBase =
            String(process.env.REFERENCE_EXACT_RAW_BASE || 'false').toLowerCase() === 'true';
          const exactReferenceBaseBuffer = isExactReferenceVariant
            ? await prepareExactReferenceBase(uploadedReferencePayload.buffer, targetCanvas)
            : null;
          if (strictReferenceLockEnabled && hasSourceImage && sourcePayload) {
            await emitReferenceProgress('addProduct');
            if (!referencePlacement) {
              try {
                referencePlacement = await analyzeReferencePlacementWithGemini({
                  referenceImage,
                  promptText: promptForModel,
                });
              } catch (strictPlacementError) {
                logWarn(
                  'StrictLock',
                  'Strict lock placement analysis fallback failed; using center placement',
                  strictPlacementError.message
                );
              }
            }
            const strictReferenceBaseBuffer =
              exactReferenceBaseBuffer ||
              await prepareExactReferenceBase(uploadedReferencePayload.buffer, targetCanvas);
            const softenedStrictReferenceBaseBuffer = await softenPlacementAreaOnReferenceBase(
              strictReferenceBaseBuffer,
              referencePlacement
            );
            const strictScaleMultiplierRaw = Number(process.env.STRICT_REFERENCE_LOCK_SCALE_MULTIPLIER || '1.02');
            const strictScaleMultiplier = Number.isFinite(strictScaleMultiplierRaw)
              ? Math.min(1.2, Math.max(0.85, strictScaleMultiplierRaw))
              : 1.02;
            imageBase64 = await compositeProductOntoBackground({
              backgroundBase64: softenedStrictReferenceBaseBuffer.toString('base64'),
              sourceBuffer: sourcePayload.buffer,
              referencePlacement,
              scaleMultiplier: strictScaleMultiplier,
            });
            imageMimeType = 'image/png';
            logInfo(
              'StrictLock',
              'Using strict reference lock: original background preserved with deterministic compositing'
            );
          } else {
          const referencePromptText = isExactReferenceVariant
            ? ''
            : (referencePromptBundle?.backgroundPrompt || '');
          let referenceSceneBlueprint = mergedReferenceAnalysis?.mergedPlan || null;
          if (isExactReferenceVariant && !referencePromptText) {
            if (!referenceSceneBlueprint?.sceneBlueprint) {
              try {
                referenceSceneBlueprint = await analyzeReferenceSceneBlueprintWithAi({
                  referenceImage,
                  promptText: promptForModel,
                  requestedAspectRatio,
                });
              } catch (blueprintError) {
                console.warn('Reference scene blueprint analysis failed, using raw image-guided exact prompt:', blueprintError.message);
              }
            }
          }

          const recreationPrompt = referencePromptText
            ? referencePromptText
            : isExactReferenceVariant
            ? (
              referenceSceneBlueprint
                ? (
                  `Create a fresh, crisp, high-resolution advertising background from this scene blueprint. ` +
                  `Match the same composition, camera angle, prop layout, lighting direction, and spatial relationships as closely as possible, but regenerate everything cleanly instead of copying source blur or compression. ` +
                  `Scene blueprint: ${referenceSceneBlueprint.sceneBlueprint}. ` +
                  `${referenceSceneBlueprint.productAreaNotes ? `Hero-product support area: ${referenceSceneBlueprint.productAreaNotes}. ` : ''}` +
                  `${referenceSceneBlueprint.cleanupNotes ? `Remove or avoid: ${referenceSceneBlueprint.cleanupNotes}. ` : ''}` +
                  `${referenceSceneBlueprint.qualityNotes ? `Quality target: ${referenceSceneBlueprint.qualityNotes}. ` : ''}` +
                  `Do not place any bottle, packshot, brand logo, text overlay, timestamp, playback control, or watermark in the scene. ` +
                  `Zero hero products in frame. Zero replacement products in frame. The output must be background-only. ` +
                  `Do NOT create any blank rectangle, translucent panel, matte card, display pedestal, placeholder box, reserved product area, vignette patch, or artificial backdrop behind the future product. ` +
                  `The removed product area must be naturally reconstructed using the same underlying support surface, textures, shadows, and perspective lines that already exist in the reference scene. ` +
                  `${referencePlacement?.supportSurface ? `Specifically continue the ${referencePlacement.supportSurface} surface cleanly through the removed product area. ` : ''}` +
                  `Keep all textures continuous and uninterrupted through the old product area so the scene looks untouched. ` +
                  `Keep the scene photorealistic, sharp, and premium with no softness, haze, painterly blur, or smeared details. ` +
                  `Aspect ratio: ${requestedAspectRatio}. ` +
                  `${backgroundPrompt ? `Scene intent: ${backgroundPrompt}. ` : ''}` +
                  `${promptForModel ? `User prompt context: ${promptForModel}.` : ''}`
                )
                : (
                  `Recreate the reference image as a clean, crisp, high-resolution advertising scene. ` +
                  `Keep the same scene type, camera angle, perspective, prop layout, lighting direction, shadows, and overall composition from the reference image as closely as possible. ` +
                  `Preserve all key recognizable structural elements, surfaces, and the same general placement structure. ` +
                  `Do not invent a different concept. Do not simplify away the key props. ` +
                  `Remove the original product and any source brand logos, labels, UI overlays, timestamps, speaker icons, playback bars, or watermarks from the reference. ` +
                  `Zero hero products in frame. Zero bottles, tubes, jars, or cosmetic packshots in the final background. ` +
                  `Do NOT create any blank rectangle, translucent panel, matte card, display pedestal, placeholder box, reserved product area, or artificial clean patch behind the future product. ` +
                  `Reconstruct the removed product area by continuing the same underlying surface and nearby textures naturally through it. ` +
                  `${referencePlacement?.supportSurface ? `Specifically continue the ${referencePlacement.supportSurface} surface across the removed product area. ` : ''}` +
                  `Keep the support surface continuous so the final background does not contain any visible box or isolated patch. ` +
                  `Do not blur the scene. Keep edges crisp and premium. ` +
                  `Aspect ratio: ${requestedAspectRatio}. ` +
                  `${backgroundPrompt ? `Scene intent: ${backgroundPrompt}. ` : ''}` +
                  `${promptForModel ? `User prompt context: ${promptForModel}.` : ''}`
                )
            )
            : (
              `Create a premium ad-ready recreation inspired by the reference image. ` +
              `Preserve the same overall scene identity, mood, atmospheric perspective, and recognizable prop family, but allow tasteful cleanup, stronger styling, cleaner staging, and a slightly more polished commercial finish. ` +
              `Keep the reference influence obvious, but you may rebalance spacing, simplify clutter, or refine prop shapes for a stronger ad composition. ` +
              `Remove the original product and any source brand logos, labels, UI overlays, timestamps, speaker icons, playback bars, or watermarks from the reference. ` +
              `Zero hero products in frame. Zero bottles, tubes, jars, or cosmetic packshots in the final background. ` +
              `Do NOT create any blank rectangle, translucent panel, matte card, display pedestal, placeholder box, reserved product area, or artificial clean patch behind the future product. ` +
              `Reconstruct the removed product area using natural continuation of the nearby surface, shadows, and textures. ` +
              `Keep the image crisp and premium. ` +
              `Aspect ratio: ${requestedAspectRatio}. ` +
              `${backgroundPrompt ? `Scene intent: ${backgroundPrompt}. ` : ''}` +
              `${promptForModel ? `User prompt context: ${promptForModel}.` : ''}`
            );

          const referenceRecreationParts = referencePromptText
            ? [
                {
                  text: isExactReferenceVariant
                    ? 'Reference image. Rebuild this same scene as a fresh, crisp, premium ad background. Keep the composition tightly matched to the uploaded reference, but leave the product area empty for compositing:'
                    : 'Reference image. Create a polished premium ad background inspired by this uploaded reference image, keeping the same scene identity and leaving the product area empty:',
                },
                {
                  inline_data: {
                    data: uploadedReferencePayload.buffer.toString('base64'),
                    mime_type: uploadedReferencePayload.mimeType,
                  },
                },
                {
                  text: recreationPrompt,
                },
              ]
            : isExactReferenceVariant && referenceSceneBlueprint
            ? [
                {
                  text:
                    'Reference scene blueprint extracted from the uploaded image. Rebuild the same composition as a fresh, crisp ad background, leaving the hero-product area empty:',
                },
                {
                  text: recreationPrompt,
                },
              ]
            : [
                {
                  text: isExactReferenceVariant
                    ? 'Reference image. Rebuild this same scene as closely as possible into a premium ad-ready background, with the old product removed and the scene kept crisp:'
                    : 'Reference image. Create a premium ad-ready recreation strongly inspired by this scene, with the old product removed and the scene kept crisp:',
                },
                {
                  inline_data: {
                    data: uploadedReferencePayload.buffer.toString('base64'),
                    mime_type: uploadedReferencePayload.mimeType,
                  },
                },
                {
                  text: recreationPrompt,
                },
              ];

          if (
            shouldUseRawExactReferenceBase &&
            !shouldForceGeminiPlacementOnly &&
            isExactReferenceVariant &&
            exactReferenceBaseBuffer &&
            hasSourceImage &&
            sourcePayload
          ) {
            await emitReferenceProgress('addProduct');
            const softenedExactReferenceBaseBuffer = await softenPlacementAreaOnReferenceBase(
              exactReferenceBaseBuffer,
              referencePlacement
            );
            const preCompositedBase64 = await compositeProductOntoBackground({
              backgroundBase64: softenedExactReferenceBaseBuffer.toString('base64'),
              sourceBuffer: sourcePayload.buffer,
              referencePlacement,
              scaleMultiplier: 0.96,
            });

            const refinePrompt =
              `Refine this advertising composite safely. The new product is exactly where it needs to be; DO NOT change its size, shape, or draw a second product. ` +
              `Do NOT move it, rotate it, or scale it. ` +
              `Your ONLY task is to add a realistic contact shadow underneath the new product and blend its edges naturally into the scene. ` +
              `If you see the old original product (like a large tube or box) sticking out from behind the new product, carefully paint it out by extending the background textures (like the chair's fabric or the sand) to cover it. ` +
              `CRITICAL: Do NOT enlarge the new product to hide the old one. Do NOT draw a giant bottle. Maintain the exact size of the placed product, and reconstruct the background directly around it to erase the old item. ` +
              `${referencePlacement?.supportSurface ? `The product must stay resting on the ${referencePlacement.supportSurface}. ` : ''}` +
              `${referencePlacement?.contactEdge ? `Preserve the same surface contact along the ${referencePlacement.contactEdge}. ` : ''}` +
              `${referencePlacement?.preserveForegroundOccluders ? 'Keep any small foreground props from the reference, such as sunglasses, in the same place and let them naturally overlap the new product if they already sit on top of the original hero object. ' : ''}` +
              `Keep the rest of the scene strictly identical to the reference image. ` +
              `Keep the result crisp, photorealistic, and premium. Aspect ratio: ${requestedAspectRatio}. ` +
              `${promptForModel ? `User prompt context: ${promptForModel}.` : ''}`;

            const { response, requestUrl } = await postGeminiWithFallback({
              model: geminiModel,
              apiKey: geminiApiKey,
              payload: {
                contents: [
                  {
                    role: 'user',
                    parts: [
                      {
                        text: 'Reference image for scene lock:',
                      },
                      {
                        inline_data: {
                          data: uploadedReferencePayload.buffer.toString('base64'),
                          mime_type: uploadedReferencePayload.mimeType,
                        },
                      },
                      {
                        text: 'Pre-composited draft with the new product already placed:',
                      },
                      {
                        inline_data: {
                          data: preCompositedBase64,
                          mime_type: 'image/png',
                        },
                      },
                      {
                        text: refinePrompt,
                      },
                    ],
                  },
                ],
                generationConfig: {
                  responseModalities: ['IMAGE'],
                },
              },
            });
            console.log(`[Gemini] Refined exact reference composite via ${requestUrl}`);

            const refinedImage = extractGeminiImagePayload(response.data, 'image/png');
            if (refinedImage?.base64) {
              imageBase64 = refinedImage.base64;
              imageMimeType = refinedImage.mimeType || 'image/png';
              
              try {
                imageBase64 = await compositeProductOntoBackground({
                  backgroundBase64: imageBase64,
                  sourceBuffer: sourcePayload.buffer,
                  referencePlacement,
                  scaleMultiplier: 0.96,
                });
                console.log('[Gemini] Restored crisp product pixels via final post-compositing step.');
              } catch (finalCompositeError) {
                console.warn('Final exact reference composite failed:', finalCompositeError.message);
              }
            } else {
              imageBase64 = preCompositedBase64;
              imageMimeType = 'image/png';
            }
          } else {
            const { response, requestUrl } = await postGeminiWithFallback({
              model: geminiModel,
              apiKey: geminiApiKey,
              payload: {
                contents: [
                  {
                    role: 'user',
                    parts: referenceRecreationParts,
                  },
                ],
                generationConfig: {
                  responseModalities: ['IMAGE'],
                },
              },
            });
            logInfo('Gemini', 'Recreated reference background', redactUrlSecrets(requestUrl));

            const extractedImage = extractGeminiImagePayload(response.data, 'image/png');
            if (extractedImage?.base64) {
              imageBase64 = extractedImage.base64;
              imageMimeType = extractedImage.mimeType || 'image/png';
              if (shouldForceGeminiPlacementOnly && hasSourceImage && sourcePayload) {
                recreatedBackgroundBase64 = extractedImage.base64;
                recreatedBackgroundMimeType = extractedImage.mimeType || 'image/png';
              }
            } else {
              throw new Error('Gemini returned no recreated background image data');
            }

            if (imageBase64 && hasSourceImage && sourcePayload) {
              try {
                await emitReferenceProgress('addProduct');
                if (shouldUseGeminiSceneEditPlacement) {
                  const placedScene = await placeProductIntoSceneWithGemini({
                    backgroundBase64: imageBase64,
                    productPayload: sourcePayload,
                    referencePayload: uploadedReferencePayload,
                    referencePlacement,
                    mergedReferencePlan: mergedReferenceAnalysis?.mergedPlan || referenceSceneBlueprint || null,
                    promptText: promptForModel,
                    requestedAspectRatio,
                    lockBackgroundOutsidePlacement: shouldForceGeminiPlacementOnly,
                  });
                  imageBase64 = placedScene.base64;
                  imageMimeType = placedScene.mimeType || 'image/png';
                } else {
                  const draftBase64 = await compositeProductOntoBackground({
                    backgroundBase64: imageBase64,
                    sourceBuffer: sourcePayload.buffer,
                    referencePlacement,
                  });
                  const refinedDraft = await refineCompositeWithAi(draftBase64);
                  imageBase64 = await compositeProductOntoBackground({
                    backgroundBase64: refinedDraft,
                    sourceBuffer: sourcePayload.buffer,
                    referencePlacement,
                  });
                  imageMimeType = 'image/png';
                }
              } catch (referenceCompositeError) {
                if (shouldForceGeminiPlacementOnly) {
                  throw new Error(`Gemini placement failed: ${referenceCompositeError.message}`);
                }
                console.warn('Reference overlay composite failed:', referenceCompositeError.message);
              }
            }
          }
          }
        } catch (referenceRecreateError) {
          const failureSummary = summarizeGenerationError(referenceRecreateError) || referenceRecreateError.message;
          const looksLikeSafetyFilter = isLikelySafetyFilterFailure(failureSummary);
          logWarn('Gemini', 'Reference recreation failed', failureSummary);

          let recoveredInStrictMode = false;

          if (strictReferenceLockEnabled && hasSourceImage && sourcePayload && uploadedReferencePayload) {
            logInfo(
              'StrictLock',
              `Strict recovery activated (safety_filter=${looksLikeSafetyFilter ? 'yes' : 'no'})`
            );

            if (!looksLikeSafetyFilter) {
              try {
                const relaxedBackground = await prepareReferenceBackgroundBase(
                  uploadedReferencePayload.buffer,
                  targetCanvas
                );
                await emitReferenceProgress('addProduct');
                imageBase64 = await compositeProductOntoBackground({
                  backgroundBase64: relaxedBackground.toString('base64'),
                  sourceBuffer: sourcePayload.buffer,
                  referencePlacement,
                  scaleMultiplier: 1,
                });
                imageMimeType = 'image/png';
                recoveredInStrictMode = Boolean(imageBase64);
                if (recoveredInStrictMode) {
                  logInfo('StrictLock', 'Recovered via relaxed strict deterministic composite (no scene recreation)');
                }
              } catch (relaxedStrictError) {
                logWarn('StrictLock', 'Relaxed strict recovery failed', summarizeGenerationError(relaxedStrictError) || relaxedStrictError.message);
              }
            }

            if (!recoveredInStrictMode) {
              try {
                const backupResult = await tryStrictModeBackupWithExternalModel({
                  endpoint: process.env.STRICT_MODE_BACKUP_ENDPOINT || '',
                  apiKey: process.env.STRICT_MODE_BACKUP_API_KEY || '',
                  promptText: promptForModel,
                  requestedAspectRatio,
                  referencePayload: uploadedReferencePayload,
                  productPayload: sourcePayload,
                  referencePlacement,
                });
                if (backupResult?.base64) {
                  imageBase64 = backupResult.base64;
                  imageMimeType = backupResult.mimeType || 'image/png';
                  recoveredInStrictMode = true;
                  logInfo('StrictLock', `Recovered via external strict backup model (${backupResult.provider || 'external-backup'})`);
                }
              } catch (backupError) {
                logWarn('StrictLock', 'External strict backup failed', summarizeGenerationError(backupError) || backupError.message);
              }
            }

            if (!recoveredInStrictMode) {
              try {
                const preparedBackground = await prepareReferenceBackgroundBase(uploadedReferencePayload.buffer, targetCanvas);
                await emitReferenceProgress('addProduct');
                imageBase64 = await compositeProductOntoBackground({
                  backgroundBase64: preparedBackground.toString('base64'),
                  sourceBuffer: sourcePayload.buffer,
                  referencePlacement,
                  scaleMultiplier: 1,
                });
                imageMimeType = 'image/png';
                recoveredInStrictMode = Boolean(imageBase64);
                if (recoveredInStrictMode) {
                  logWarn('StrictLock', 'Recovered with final fallback: raw reference base + deterministic composite');
                }
              } catch (strictFinalFallbackError) {
                logWarn('StrictLock', 'Final strict fallback failed', summarizeGenerationError(strictFinalFallbackError) || strictFinalFallbackError.message);
              }
            }
          }

          if (!recoveredInStrictMode) {
            logWarn('Gemini', 'Trying text-only fallback before raw reference background', referenceRecreateError.message);
            try {
              if (!referencePromptBundle?.backgroundPrompt) {
                throw new Error('No reference background prompt available');
              }
              const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
              const geminiApiKey = process.env.GEMINI_API_KEY;
              const { response } = await postGeminiWithFallback({
                model: geminiModel,
                apiKey: geminiApiKey,
                payload: {
                  contents: [
                    {
                      role: 'user',
                      parts: [
                        {
                          text:
                            `Create a clean premium advertising background with no product in frame. ` +
                            `${referencePromptBundle.backgroundPrompt}`,
                        },
                      ],
                    },
                  ],
                  generationConfig: {
                    responseModalities: ['IMAGE'],
                  },
                },
              });
              const extractedFallbackImage = extractGeminiImagePayload(response.data, 'image/png');
              if (!extractedFallbackImage?.base64) {
                throw new Error('Gemini returned no text-only fallback background image data');
              }
              imageBase64 = extractedFallbackImage.base64;
              imageMimeType = extractedFallbackImage.mimeType || 'image/png';
              if (shouldForceGeminiPlacementOnly && hasSourceImage && sourcePayload) {
                recreatedBackgroundBase64 = extractedFallbackImage.base64;
                recreatedBackgroundMimeType = extractedFallbackImage.mimeType || 'image/png';
              }
            } catch (textFallbackError) {
              logWarn('Gemini', 'Text-only reference fallback failed; using uploaded reference background', textFallbackError.message);
              const preparedBackground = await prepareReferenceBackgroundBase(uploadedReferencePayload.buffer, targetCanvas);
              imageBase64 = preparedBackground.toString('base64');
              imageMimeType = 'image/png';
              if (shouldForceGeminiPlacementOnly && hasSourceImage && sourcePayload) {
                recreatedBackgroundBase64 = imageBase64;
                recreatedBackgroundMimeType = 'image/png';
              }
            }

            if (imageBase64 && hasSourceImage && sourcePayload) {
              try {
                await emitReferenceProgress('addProduct');
                if (shouldUseGeminiSceneEditPlacement) {
                  const placedScene = await placeProductIntoSceneWithGemini({
                    backgroundBase64: imageBase64,
                    productPayload: sourcePayload,
                    referencePayload: uploadedReferencePayload,
                    referencePlacement,
                    mergedReferencePlan: mergedReferenceAnalysis?.mergedPlan || null,
                    promptText: promptForModel,
                    requestedAspectRatio,
                    lockBackgroundOutsidePlacement: shouldForceGeminiPlacementOnly,
                  });
                  imageBase64 = placedScene.base64;
                  imageMimeType = placedScene.mimeType || 'image/png';
                } else {
                  const draftBase64 = await compositeProductOntoBackground({
                    backgroundBase64: imageBase64,
                    sourceBuffer: sourcePayload.buffer,
                    referencePlacement,
                  });
                  const refinedDraft = await refineCompositeWithAi(draftBase64);
                  imageBase64 = await compositeProductOntoBackground({
                    backgroundBase64: refinedDraft,
                    sourceBuffer: sourcePayload.buffer,
                    referencePlacement,
                  });
                  imageMimeType = 'image/png';
                }
              } catch (referenceFallbackCompositeError) {
                if (shouldForceGeminiPlacementOnly) {
                  throw new Error(`Gemini placement fallback failed: ${referenceFallbackCompositeError.message}`);
                }
                console.warn('Reference fallback composite failed:', referenceFallbackCompositeError.message);
              }
            }
          }
        }
      } else {
        if (shouldUseOpenAIImages) {
          try {
            const imageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
            if (hasSourceImage && sourcePayload) {
              const imageFile = await toFile(sourcePayload.buffer, 'product.png', {
                type: sourcePayload.mimeType,
              });
              const imageEditPayload = {
                model: imageModel,
                image: imageFile,
                prompt: effectiveInstruction,
              };
              if (imageModel === 'gpt-image-1') {
                imageEditPayload.input_fidelity = 'high';
              }
              const openaiImageResponse = await openai.images.edit(imageEditPayload);
              imageBase64 = openaiImageResponse?.data?.[0]?.b64_json || null;
              imageMimeType = 'image/png';
            } else {
              const openaiImageResponse = await openai.images.generate({
                model: imageModel,
                prompt: effectiveInstruction,
              });
              imageBase64 = openaiImageResponse?.data?.[0]?.b64_json || null;
              imageMimeType = 'image/png';
            }
            if (!imageBase64) {
              console.warn('OpenAI returned no image payload; falling back to Gemini generation.');
            }
          } catch (openAiGenerationError) {
            console.warn('OpenAI image generation failed; falling back to Gemini generation:', openAiGenerationError.message);
          }
        }

        if (!imageBase64) {
          const geminiModel = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
          const geminiApiKey = process.env.GEMINI_API_KEY;
          let referencePart = null;
          let backgroundReferencePart = null;
          if (hasSourceImage && sourcePayload && resolvedReferenceMode === 'edit') {
            referencePart = {
              inline_data: {
                data: sourcePayload.buffer.toString('base64'),
                mime_type: sourcePayload.mimeType,
              },
            };
          }
          if (hasBackgroundReferenceImage && uploadedReferencePayload) {
            backgroundReferencePart = {
              inline_data: {
                data: uploadedReferencePayload.buffer.toString('base64'),
                mime_type: uploadedReferencePayload.mimeType,
              },
            };
          }

          const backgroundInstruction = backgroundPrompt
            ? `Create a background scene only for later product compositing. No product, no bottle, no packshot, no logos, no text. ${backgroundPrompt}.${backgroundReferenceGuideInstruction}${logoCornerInstruction}${brandTextGuardInstruction}${ctaTextGuardInstruction}`
            : effectiveInstruction;

          const parts = referencePart
            ? [
                referencePart,
                ...(backgroundReferencePart
                  ? [
                      { text: 'Optional background reference image. Match this background scene closely while preserving the original product from the first image:' },
                      backgroundReferencePart,
                    ]
                  : []),
                { text: effectiveInstruction },
              ]
            : backgroundReferencePart
              ? [
                  { text: 'Background reference image. Match this scene closely, but generate only the background because the product will be composited separately:' },
                  backgroundReferencePart,
                  { text: backgroundInstruction },
                ]
              : [{ text: backgroundInstruction }];

          const { response, requestUrl } = await postGeminiWithFallback({
            model: geminiModel,
            apiKey: geminiApiKey,
            payload: {
              contents: [
                {
                  role: 'user',
                  parts,
                },
              ],
              generationConfig: {
                responseModalities: ['IMAGE'],
              },
            },
          });
          logInfo('Gemini', 'Image generated', redactUrlSecrets(requestUrl));

          const extractedImage = extractGeminiImagePayload(response.data, imageMimeType);
          if (extractedImage?.base64) {
            imageBase64 = extractedImage.base64;
            imageMimeType = extractedImage.mimeType || imageMimeType;
          } else {
            const summary = summarizeGeminiNoImage(response.data);
            const preview = JSON.stringify(response.data || {}).slice(0, 1000);
            console.warn('Gemini returned no image payload', {
              summary: summary || null,
              preview,
            });
            throw new Error(summary ? `Gemini returned no image data (${summary})` : 'Gemini returned no image data');
          }

          if (imageBase64 && hasSourceImage && resolvedReferenceMode === 'overlay' && sourcePayload) {
            try {
              const draftBase64 = await compositeProductOntoBackground({
                backgroundBase64: imageBase64,
                sourceBuffer: sourcePayload.buffer,
                referencePlacement,
              });
              const refinedDraft = await refineCompositeWithAi(draftBase64);
              imageBase64 = await compositeProductOntoBackground({
                backgroundBase64: refinedDraft,
                sourceBuffer: sourcePayload.buffer,
                referencePlacement,
              });
              imageMimeType = 'image/png';
            } catch (compositeError) {
              console.warn('Overlay composite failed:', compositeError.message);
            }
          }
        }
      }
    } catch (generationError) {
      throw generationError;
    }

    if (imageBase64 && shouldUseOpenAIImages && hasSourceImage && resolvedReferenceMode === 'overlay' && sourcePayload) {
      try {
        imageBase64 = await compositeProductOntoBackground({
          backgroundBase64: imageBase64,
          sourceBuffer: sourcePayload.buffer,
          referencePlacement,
        });
        imageMimeType = 'image/png';
      } catch (compositeError) {
        console.warn('OpenAI overlay composite failed:', compositeError.message);
      }
    }

    if (imageBase64 && logoPayload) {
      try {
        const backgroundBuffer = Buffer.from(imageBase64, 'base64');
        const bgMeta = await sharp(backgroundBuffer).metadata();
        const bgWidth = bgMeta.width || 1024;
        const bgHeight = bgMeta.height || 1024;

        let logoBuffer = logoPayload.buffer;
        let logoMeta = await sharp(logoBuffer).metadata();

        if (logoMeta.hasAlpha) {
          try {
            const trimmed = await sharp(logoBuffer)
              .ensureAlpha()
              .trim()
              .toBuffer({ resolveWithObject: true });
            logoBuffer = trimmed.data;
            logoMeta = { width: trimmed.info.width, height: trimmed.info.height };
          } catch (trimError) {
            // fallback to untrimmed logo
          }
        }

        const maxLogoWidth = Math.round(bgWidth * 0.18);
        const maxLogoHeight = Math.round(bgHeight * 0.18);
        const scale = Math.min(
          1,
          maxLogoWidth / (logoMeta.width || maxLogoWidth),
          maxLogoHeight / (logoMeta.height || maxLogoHeight)
        );

        const finalLogoWidth = Math.max(1, Math.round((logoMeta.width || maxLogoWidth) * scale));
        const finalLogoHeight = Math.max(1, Math.round((logoMeta.height || maxLogoHeight) * scale));

        const resizedLogo = await sharp(logoBuffer)
          .resize(finalLogoWidth, finalLogoHeight, { fit: 'inside' })
          .toBuffer();

        const padding = Math.round(bgWidth * 0.04);
        const left = Math.max(0, bgWidth - finalLogoWidth - padding);
        const top = Math.max(0, padding);

        const composited = await sharp(backgroundBuffer)
          .resize(bgWidth, bgHeight, { fit: 'cover' })
          .composite([{ input: resizedLogo, left, top }])
          .png()
          .toBuffer();

        imageBase64 = composited.toString('base64');
        imageMimeType = 'image/png';
      } catch (logoError) {
        console.warn('Logo overlay failed:', logoError.message);
      }
    }

    if (imageBase64 && requestedBrandTextOverlay) {
      try {
        const brandLines = splitBrandOverlayLines(requestedBrandTextOverlay);
        if (brandLines.length) {
          const backgroundBuffer = Buffer.from(imageBase64, 'base64');
          const bgMeta = await sharp(backgroundBuffer).metadata();
          const bgWidth = bgMeta.width || 1024;
          const bgHeight = bgMeta.height || 1024;

          const fontSize = Math.max(34, Math.round(bgWidth * 0.075));
          const lineHeight = Math.max(40, Math.round(fontSize * 1.02));
          const padding = Math.round(bgWidth * 0.04);
          const maxTextWidth = Math.round(bgWidth * 0.48);
          const longestLineLength = Math.max(...brandLines.map((line) => String(line || '').length), 8);
          const estimatedTextWidth = Math.round(longestLineLength * fontSize * 0.55);
          const overlayWidth = Math.max(
            Math.round(bgWidth * 0.28),
            Math.min(maxTextWidth, estimatedTextWidth + Math.round(fontSize * 0.7))
          );
          const overlayHeight = Math.max(
            Math.round(bgHeight * 0.12),
            brandLines.length * lineHeight + Math.round(fontSize * 0.35)
          );
          const left = logoPayload
            ? Math.max(0, padding)
            : Math.max(0, bgWidth - overlayWidth - padding);
          const top = Math.max(0, padding);
          const anchor = logoPayload ? 'start' : 'end';
          const textX = logoPayload
            ? Math.round(fontSize * 0.2)
            : Math.max(Math.round(fontSize * 0.2), overlayWidth - Math.round(fontSize * 0.2));
          const firstLineY = Math.round(fontSize * 0.95);
          const strokeWidth = Math.max(1, Math.round(fontSize * 0.04));
          const tspans = brandLines
            .map((line, index) => {
              const y = firstLineY + (index * lineHeight);
              return `<tspan x="${textX}" y="${y}">${escapeSvgText(line)}</tspan>`;
            })
            .join('');

          const svg = `
            <svg width="${overlayWidth}" height="${overlayHeight}" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <filter id="softShadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="rgba(0,0,0,0.65)"/>
                </filter>
              </defs>
              <text
                x="${textX}"
                y="${firstLineY}"
                text-anchor="${anchor}"
                fill="#ffffff"
                stroke="rgba(0,0,0,0.42)"
                stroke-width="${strokeWidth}"
                paint-order="stroke"
                font-size="${fontSize}"
                font-family="Arial, Helvetica, sans-serif"
                font-weight="700"
                filter="url(#softShadow)"
              >${tspans}</text>
            </svg>
          `;

          const composited = await sharp(backgroundBuffer)
            .composite([{ input: Buffer.from(svg), left, top }])
            .png()
            .toBuffer();

          imageBase64 = composited.toString('base64');
          imageMimeType = 'image/png';
        }
      } catch (brandTextOverlayError) {
        console.warn('Brand text overlay failed:', brandTextOverlayError.message);
      }
    }

    if (imageBase64 && shouldForceCtaOverlay && requestedCtaText && requestedCtaText !== 'None') {
      try {
        const backgroundBuffer = Buffer.from(imageBase64, 'base64');
        const bgMeta = await sharp(backgroundBuffer).metadata();
        const bgWidth = bgMeta.width || 1024;
        const bgHeight = bgMeta.height || 1024;

        const fontSize = Math.max(22, Math.round(bgWidth * 0.045));
        const horizontalPadding = Math.max(22, Math.round(fontSize * 0.9));
        const verticalPadding = Math.max(10, Math.round(fontSize * 0.45));
        const approxTextWidth = Math.max(fontSize * 3, Math.round(requestedCtaText.length * fontSize * 0.58));
        const buttonWidth = Math.min(
          Math.round(bgWidth * 0.78),
          Math.max(Math.round(bgWidth * 0.28), approxTextWidth + horizontalPadding * 2)
        );
        const buttonHeight = Math.round(fontSize + verticalPadding * 2);
        const radius = Math.max(8, Math.round(buttonHeight * 0.24));
        const left = Math.max(0, Math.round((bgWidth - buttonWidth) / 2));
        const bottomMargin = Math.round(bgHeight * 0.08);
        const top = Math.max(0, bgHeight - bottomMargin - buttonHeight);
        const safeText = escapeSvgText(requestedCtaText);

        const innerRadius = Math.max(6, radius - 3);
        const svg = `
          <svg width="${buttonWidth}" height="${buttonHeight}" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="ctaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="#ef4444"/>
                <stop offset="100%" stop-color="#b91c1c"/>
              </linearGradient>
            </defs>
            <rect x="0.5" y="0.5" width="${buttonWidth - 1}" height="${buttonHeight - 1}" rx="${radius}" ry="${radius}" fill="rgba(10,10,14,0.68)" stroke="rgba(255,255,255,0.28)" stroke-width="1"/>
            <rect x="3" y="3" width="${buttonWidth - 6}" height="${buttonHeight - 6}" rx="${innerRadius}" ry="${innerRadius}" fill="url(#ctaGradient)" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
            <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" fill="#ffffff" font-size="${fontSize}" font-family="Arial, Helvetica, sans-serif" font-weight="700">${safeText}</text>
          </svg>
        `;

        const composited = await sharp(backgroundBuffer)
          .composite([{ input: Buffer.from(svg), left, top }])
          .png()
          .toBuffer();

        imageBase64 = composited.toString('base64');
        imageMimeType = 'image/png';
      } catch (ctaOverlayError) {
        console.warn('CTA overlay failed:', ctaOverlayError.message);
      }
    }

    const imageUrl = imageBase64 ? `data:${imageMimeType};base64,${imageBase64}` : null;

    if (!imageUrl) {
      throw new Error('Failed to parse image from Gemini response');
    }

    res.json({
      caption: shouldSuppressCaptionOutput ? '' : generatedCaption,
      editInstruction: editInstruction || undefined,
      captionType: 'caption',
      generationVariant: normalizedGenerationVariant || undefined,
      usedReferenceImage: hasBackgroundReferenceImage,
      referenceMode: resolvedReferenceMode,
      generationFlow,
      pipelineName: resolvePipelineNameFromGenerationFlow(generationFlow, resolvedReferenceMode),
      requestedPipeline: projectApiPolicyContext?.requestedPipeline || undefined,
      effectivePipeline:
        projectApiPolicyContext?.effectivePipeline ||
        resolvePipelineNameFromGenerationFlow(generationFlow, resolvedReferenceMode),
      pipelineOverrideRejected: projectApiPolicyContext?.overrideRejected === true || undefined,
      pipelineRejectionReason: projectApiPolicyContext?.rejectionReason || undefined,
      strictReferenceLock: strictReferenceLockEnabled || undefined,
      backgroundPrompt: backgroundPrompt || undefined,
      imageUrl: imageUrl,
      recreatedBackgroundImageUrl:
        shouldForceGeminiPlacementOnly && recreatedBackgroundBase64
          ? `data:${recreatedBackgroundMimeType};base64,${recreatedBackgroundBase64}`
          : undefined,
      remainingCredits,
    });

  } catch (error) {
    const geminiDetails = error?.details || error?.cause?.details || null;
    if (creditReserved && hasUserAccountContext) {
      try {
        const refundResult = await pool.query(
          `
            UPDATE users
            SET credits = credits + 1
            WHERE id = $1
            RETURNING credits
          `,
          [req.user.id]
        );
        remainingCredits = Number(refundResult.rows[0]?.credits ?? remainingCredits ?? 0);
      } catch (refundError) {
        console.error('Credit refund failed:', refundError.message);
      }
    }

    const errorData = error.response?.data;
    const errorDetails =
      errorData?.error?.message ||
      errorData?.error ||
      errorData ||
      error.message;
    const errorText =
      typeof errorDetails === 'string' ? errorDetails : JSON.stringify(errorDetails);
    const upstreamStatus = getUpstreamHttpStatus(error);
    const responseStatus = mapUpstreamStatusToClientStatus(upstreamStatus);
    const responseDetails =
      responseStatus === 503
        ? `${errorText} (upstream service unavailable, please retry)`
        : errorText;
    
    console.error('[API /generate] Error generating content:', {
      message: error.message,
      stack: error.stack,
      errorText,
      upstreamStatus,
      errorData: JSON.stringify(errorData),
      geminiDetails: geminiDetails ? JSON.stringify(geminiDetails).slice(0, 1000) : null,
    });

    res.status(responseStatus).json({
      error: 'Generation failed',
      details: responseDetails,
      upstreamStatus: upstreamStatus || undefined,
    });
  }
};

app.post('/api/generate', requireAuthOrInternal, handleGenerateApi);
app.post(
  PROJECT_API_EXTERNAL_GENERATE_PATH,
  attachProjectApiExternalLogCapture,
  requireProjectApiKey,
  normalizeExternalGeneratePayloadToWebDefaults,
  enforceExternalPipelinePolicy('generate'),
  handleGenerateApi
);
app.post(
  PROJECT_API_EXTERNAL_ANALYZE_PATH,
  attachProjectApiExternalLogCapture,
  requireProjectApiKey,
  normalizeExternalAnalyzePayloadToWebDefaults,
  enforceExternalPipelinePolicy('analyze'),
  handleAnalyzeApi
);

app.get('/api/telegram/payment/success', async (req, res) => {
  const queryTelegramId = String(req.query?.telegram_id || '').trim();
  const sessionId = String(req.query?.session_id || '').trim();
  if (!stripe) {
    return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
      telegramId: queryTelegramId,
      message: 'stripe_not_configured',
    }));
  }
  if (!sessionId) {
    return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
      telegramId: queryTelegramId,
      message: 'missing_session_id',
    }));
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (!checkoutSession) {
      return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
        telegramId: queryTelegramId,
        message: 'session_not_found',
      }));
    }

    const metadata = checkoutSession.metadata || {};
    const telegramId = String(metadata.telegram_id || queryTelegramId).trim();
    const userId = String(metadata.user_id || checkoutSession.client_reference_id || '').trim();
    const planTier = normalizePlanTier(metadata.plan_tier);
    const isPaid =
      String(checkoutSession.payment_status || '').toLowerCase() === 'paid' ||
      String(checkoutSession.status || '').toLowerCase() === 'complete';

    if (!telegramId) {
      return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
        message: 'missing_telegram_id',
      }));
    }
    if (!isPaid) {
      return res.redirect(buildTelegramPaymentStatusRedirectUrl('pending', {
        telegramId,
        message: 'payment_not_completed',
      }));
    }

    if (userId && planTier !== 'free') {
      const updatedUser = await applyPlanToUser({
        userId,
        planTier,
        stripeCustomerId: checkoutSession.customer ? String(checkoutSession.customer) : null,
        stripeSubscriptionId: checkoutSession.subscription ? String(checkoutSession.subscription) : null,
      });
      if (!updatedUser) {
        return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
          telegramId,
          message: 'plan_user_not_found',
        }));
      }

      await sendTelegramPlanActivatedMessage({
        telegramId,
        planTier,
        creditsBalance: Number(updatedUser.credits || 0),
      });

      const plan = getPlanConfig(planTier);
      return renderTelegramTopupSuccessPage(res, {
        telegramId,
        badgeText: 'Subscription Active',
        headline: `${plan.name} plan activated`,
        leadText: 'Your payment has been confirmed and your subscription is now active.',
        detailLine: `${Math.floor(Number(plan.monthlyCredits || 0))} credits are now available every month.`,
      });
    }

    const creditsToAddRaw = Number(metadata.credits_to_add || metadata.credits || TELEGRAM_TOPUP_CREDITS);
    const topupResult = await applyTelegramTopupCredits({
      telegramId,
      creditsToAdd: creditsToAddRaw,
      sessionId,
      source: 'stripe_success_redirect',
      notifyUser: true,
    });

    if (!topupResult.ok && topupResult.reason === 'user_not_found') {
      return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
        telegramId,
        message: 'telegram_user_not_found',
      }));
    }

    return renderTelegramTopupSuccessPage(res, {
      telegramId,
      creditsAdded: topupResult.creditsAdded || 0,
      duplicate: topupResult.duplicate === true,
    });
  } catch (error) {
    console.error('Telegram payment success callback failed:', error.message);
    return res.redirect(buildTelegramPaymentStatusRedirectUrl('error', {
      telegramId: queryTelegramId,
      message: 'server_error',
    }));
  }
});

app.get('/api/telegram/payment/cancel', (req, res) => {
  const telegramId = String(req.query?.telegram_id || '').trim();
  return res.redirect(buildTelegramPaymentStatusRedirectUrl('cancel', { telegramId }));
});

const handlePaymentWebhook = async (req, res) => {
  try {
    const payload = req.body || {};
    const stripeSignature = req.headers['stripe-signature'];
    let stripeEvent = null;

    if (stripe && payload?.type && payload?.data?.object) {
      if (activeStripeWebhookSecret && stripeSignature && req.rawBody) {
        try {
          stripeEvent = stripe.webhooks.constructEvent(req.rawBody, stripeSignature, activeStripeWebhookSecret);
        } catch (error) {
          return res.status(400).json({ error: `Stripe signature verification failed: ${error.message}` });
        }
      } else {
        stripeEvent = payload;
      }
    }

    if (stripeEvent) {
      const eventType = String(stripeEvent.type || '').toLowerCase();
      const eventObject = stripeEvent.data?.object || {};

      if (eventType === 'checkout.session.completed' || eventType === 'checkout.session.async_payment_succeeded') {
        const metadata = eventObject.metadata || {};
        const userId = String(metadata.user_id || eventObject.client_reference_id || '').trim();
        const planTier = normalizePlanTier(metadata.plan_tier);
        if (userId && planTier !== 'free') {
          const updatedUser = await applyPlanToUser({
            userId,
            planTier,
            stripeCustomerId: eventObject.customer ? String(eventObject.customer) : null,
            stripeSubscriptionId: eventObject.subscription ? String(eventObject.subscription) : null,
          });

          const telegramIdFromMetadata = String(metadata.telegram_id || metadata.telegramId || '').trim();
          await sendTelegramPlanActivatedMessage({
            telegramId: telegramIdFromMetadata,
            planTier,
            creditsBalance: Number(updatedUser?.credits || 0),
          });

          return res.json({
            ok: true,
            source: 'stripe',
            event: stripeEvent.type,
            user_id: userId,
            plan_tier: updatedUser?.plan_tier || planTier,
            credits_balance: updatedUser?.credits ?? null,
          });
        }

        const telegramIdFromMetadata = String(metadata.telegram_id || metadata.telegramId || '').trim();
        if (!telegramIdFromMetadata) {
          return res.status(400).json({ error: 'Invalid checkout metadata: missing user_id/plan_tier or telegram_id' });
        }
        const creditsToAddRaw = Number(metadata.credits_to_add || metadata.credits || TELEGRAM_TOPUP_CREDITS);
        const sessionId = String(eventObject.id || '').trim();
        if (!sessionId) {
          return res.status(400).json({ error: 'Missing Stripe checkout session id' });
        }
        const topupResult = await applyTelegramTopupCredits({
          telegramId: telegramIdFromMetadata,
          creditsToAdd: creditsToAddRaw,
          sessionId,
          source: 'stripe_webhook',
          notifyUser: true,
        });
        if (!topupResult.ok && topupResult.reason === 'user_not_found') {
          return res.status(404).json({ error: 'User not found for provided telegram_id' });
        }

        return res.json({
          ok: true,
          source: 'stripe_topup',
          event: stripeEvent.type,
          telegram_id: telegramIdFromMetadata,
          duplicate: topupResult.duplicate === true,
          credits_added: topupResult.creditsAdded || 0,
          credits_balance: topupResult.creditsBalance ?? null,
        });
      }

      if (eventType === 'invoice.paid') {
        const customerId = String(eventObject.customer || '').trim();
        const subscriptionId = String(eventObject.subscription || '').trim();
        if (customerId) {
          await pool.query(
            `
              UPDATE users
              SET plan_status = 'active',
                  credits = daily_credit_quota,
                  stripe_subscription_id = COALESCE(NULLIF($1, ''), stripe_subscription_id),
                  updated_at = NOW()
              WHERE stripe_customer_id = $2
            `,
            [subscriptionId, customerId]
          );
        }
        return res.json({ ok: true, source: 'stripe', event: stripeEvent.type });
      }

      if (eventType === 'customer.subscription.updated') {
        const customerId = String(eventObject.customer || '').trim();
        const subscriptionId = String(eventObject.subscription || eventObject.id || '').trim();
        if (customerId) {
          await pool.query(
            `
              UPDATE users
              SET plan_status = 'active',
                  stripe_subscription_id = COALESCE(NULLIF($1, ''), stripe_subscription_id),
                  updated_at = NOW()
              WHERE stripe_customer_id = $2
            `,
            [subscriptionId, customerId]
          );
        }
        return res.json({ ok: true, source: 'stripe', event: stripeEvent.type });
      }

      if (eventType === 'invoice.payment_failed') {
        const customerId = String(eventObject.customer || '').trim();
        if (customerId) {
          await pool.query(
            `
              UPDATE users
              SET plan_status = 'past_due'
              WHERE stripe_customer_id = $1
            `,
            [customerId]
          );
        }
        return res.json({ ok: true, source: 'stripe', event: stripeEvent.type });
      }

      if (eventType === 'customer.subscription.deleted') {
        const subscriptionId = String(eventObject.id || '').trim();
        if (subscriptionId) {
          const freePlan = getPlanConfig('free');
          await pool.query(
            `
              UPDATE users
              SET plan_tier = 'free',
                  plan_status = 'inactive',
                  daily_credit_quota = $1,
                  credits = LEAST(credits, $1),
                  stripe_subscription_id = NULL
              WHERE stripe_subscription_id = $2
            `,
            [freePlan.monthlyCredits, subscriptionId]
          );
        }
        return res.json({ ok: true, source: 'stripe', event: stripeEvent.type });
      }

      return res.status(202).json({ ok: true, source: 'stripe', message: 'Ignored event', event: stripeEvent.type });
    }

    // Legacy/generic payment webhook for Telegram credit top-up.
    const metadata =
      payload.metadata ||
      payload?.data?.object?.metadata ||
      payload?.payment?.metadata ||
      {};

    const statusValue = String(
      payload.status ||
      payload.payment_status ||
      payload?.data?.object?.payment_status ||
      payload.event ||
      payload.type ||
      ''
    ).toLowerCase();
    const eventType = String(payload.type || payload.event || '').toLowerCase();
    const isSuccessful =
      payload.success === true ||
      ['paid', 'success', 'successful', 'succeeded', 'completed', 'payment_success'].includes(statusValue) ||
      eventType === 'checkout.session.completed';

    if (!isSuccessful) {
      return res.status(202).json({ ok: true, message: 'Ignored non-successful payment event' });
    }

    const telegramId = String(
      metadata.telegram_id ||
      metadata.telegramId ||
      payload.telegram_id ||
      payload.telegramId ||
      payload.reference ||
      ''
    ).trim();

    if (!telegramId) {
      return res.status(400).json({ error: 'telegram_id missing in payment metadata' });
    }

    const creditsToAddRaw = Number(
      metadata.credits_to_add ||
      metadata.credits ||
      payload.credits ||
      TELEGRAM_TOPUP_CREDITS
    );
    const legacySessionId = String(
      payload?.data?.object?.id ||
      payload?.session_id ||
      payload?.checkout_session_id ||
      ''
    ).trim();
    const fallbackSessionKeySeed = String(payload?.id || payload?.event || payload?.type || '').trim();
    const fallbackBodyHash = req.rawBody
      ? crypto.createHash('sha1').update(req.rawBody).digest('hex').slice(0, 24)
      : '';
    const resolvedSessionId = legacySessionId ||
      `legacy_${fallbackSessionKeySeed || fallbackBodyHash || Date.now().toString(36)}_${telegramId}`;

    const topupResult = await applyTelegramTopupCredits({
      telegramId,
      creditsToAdd: creditsToAddRaw,
      sessionId: resolvedSessionId,
      source: 'legacy_webhook',
      notifyUser: true,
    });

    if (!topupResult.ok && topupResult.reason === 'user_not_found') {
      return res.status(404).json({ error: 'User not found for provided telegram_id' });
    }

    return res.json({
      ok: true,
      telegram_id: telegramId,
      duplicate: topupResult.duplicate === true,
      credits_added: topupResult.creditsAdded || 0,
      credits_balance: topupResult.creditsBalance ?? null,
    });
  } catch (error) {
    console.error('Payment webhook failed:', error.message);
    return res.status(500).json({
      error: 'Payment webhook failed',
      details: error.message || 'Unknown error',
    });
  }
};

app.post('/webhook/payment', handlePaymentWebhook);
app.post('/api/webhook/payment', handlePaymentWebhook);

if (HAS_STATIC_CLIENT) {
  app.get(/^\/(?!api(?:\/|$)).*/, (req, res) => {
    res.sendFile(STATIC_INDEX_PATH);
  });
}

const initServer = async () => {
  await ensureBootstrapSchemaOnStart();
  if (DB_AUTO_DDL) {
    await syncPlanDefinitions();
    await syncTopupPackages({ force: true });
    await ensureIntegrationSettingsTable();
    await seedIntegrationSettingsDefaults();
    await ensureProjectApiKeysTable();
    await ensureProjectApiLogsTable();
    await ensureStripeTopupHistoryTable();
    await ensureTelegramGenerationJobsTable();
  } else {
    try {
      await loadPlanDefinitionsFromDb();
    } catch (error) {
      console.warn(`Plan settings load skipped while DB_AUTO_DDL=false: ${error.message}`);
    }
    try {
      await syncTopupPackages({ force: true });
    } catch (error) {
      console.warn(`Top-up package load skipped while DB_AUTO_DDL=false: ${error.message}`);
      TOPUP_PACK_DEFINITIONS = JSON.parse(JSON.stringify(DEFAULT_TOPUP_PACK_DEFINITIONS));
    }
  }
  try {
    await syncConnectionRuntimeFromDb();
  } catch (error) {
    console.warn(`Connection settings runtime sync failed, falling back to env: ${error.message}`);
    refreshStripeRuntimeFromEnv();
    refreshOpenAiRuntimeFromEnv();
    refreshSmtpRuntimeFromEnv();
  }
  await ensureDefaultAdminUser();
  await ensureSuperAdminUser();
};

const startServer = async () => {
  await initServer();
  startVideoLifecycleTasks();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startTelegramRuntime().catch((error) => {
      console.error('Failed to start Telegram runtime:', error.message);
    });
  });
};

const shutdown = async (signal) => {
  try {
    stopVideoLifecycleTasks();
    await stopTelegramRuntime(signal);
    await pool.end();
  } catch (error) {
    console.error('Shutdown error:', error.message);
  } finally {
    process.exit(0);
  }
};

if (require.main === module) {
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  startServer().catch((error) => {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  });
}

module.exports = app;
module.exports.startServer = startServer;
module.exports.initServer = initServer;
module.exports.shutdown = shutdown;

