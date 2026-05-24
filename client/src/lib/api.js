const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

export const getApiBaseUrl = () => {
  const configuredBaseUrl = trimTrailingSlash(import.meta.env.VITE_API_BASE_URL || '');
  return configuredBaseUrl;
};

export const apiUrl = (path) => {
  const normalizedPath = String(path || '').startsWith('/') ? String(path || '') : `/${String(path || '')}`;
  const baseUrl = getApiBaseUrl();
  return baseUrl ? `${baseUrl}${normalizedPath}` : normalizedPath;
};
