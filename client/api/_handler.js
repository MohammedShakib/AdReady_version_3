const app = require('../../server/index.js');

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
  app(req, res);
};
