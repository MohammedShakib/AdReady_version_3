const app = require('../server/index.js');

let initPromise = null;

const ensureInit = () => {
  if (!initPromise) {
    initPromise = app.initServer().catch((err) => {
      console.error('Server init failed:', err.message);
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
};

const normalizeIncomingApiPath = (req) => {
  try {
    const requestUrl = new URL(req.url || '/', 'https://adready.local');
    const proxiedPath = requestUrl.searchParams.get('__path');
    if (proxiedPath && proxiedPath.startsWith('/api/')) {
      req.url = proxiedPath;
      return proxiedPath.split('?')[0];
    }
    return requestUrl.pathname;
  } catch (error) {
    console.warn('API proxy path normalization failed:', error.message);
    return String(req.url || '').split('?')[0] || '/';
  }
};

module.exports = async (req, res) => {
  await ensureInit();
  const requestPath = normalizeIncomingApiPath(req);
  const telegramWebhookPath = String(process.env.TELEGRAM_WEBHOOK_PATH || '/api/webhook').split('?')[0];
  if (requestPath === telegramWebhookPath && typeof app.startTelegramRuntime === 'function') {
    await app.startTelegramRuntime({ restart: false, configureWebhook: false });
  }
  app(req, res);
};
