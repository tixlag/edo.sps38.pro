import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { join } from 'path';

export default defineConfig(({ mode }) => {
  // Root .env is authoritative: load it explicitly in addition to apps/web/.env.
  // Do not rely on process cwd when running vite from the workspace root.
  const rootDir = join(__dirname, '..', '..');
  const rootEnv = loadEnv(mode, rootDir, '');
  for (const [k, v] of Object.entries(rootEnv)) {
    if (!(k in process.env) && v !== undefined) process.env[k] = v;
  }
  // Client-exposed VITE_* values come from env files only; explicit process
  // env (CI, e2e) must win when set. `define` overrides file-based values.
  const clientOverrides: Record<string, string> = {};
  for (const key of ['VITE_API_BASE_URL', 'VITE_AUTH_REFRESH_URL', 'VITE_ALLOW_INSECURE_DEV_AUTH']) {
    const value = process.env[key];
    if (value !== undefined) {
      clientOverrides[`import.meta.env.${key}`] = JSON.stringify(value);
    }
  }
  return {
    plugins: [react()],
    server: { port: 5173 },
    envDir: rootDir,
    define: clientOverrides,
  };
});
