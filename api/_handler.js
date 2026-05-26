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

module.exports = async (req, res) => {
  await ensureInit();
  try {
    const requestUrl = new URL(req.url || '/', 'https://adready.local');
    const proxiedPath = requestUrl.searchParams.get('__path');
    if (proxiedPath && proxiedPath.startsWith('/api/')) {
      req.url = proxiedPath;
    }
  } catch (error) {
    console.warn('API proxy path normalization failed:', error.message);
  }
  app(req, res);
};
