import { defineConfig } from 'orval';

export default defineConfig({
  lk: {
    input: './openapi/edo.json',
    output: {
      target: './src/generated/api.ts',
      // Backend client: plain fetch functions, no React Query.
      client: 'fetch',
      mode: 'single',
      clean: false,
      prettier: true,
      override: {
        // Keep the generated fetch client cookie-free; auth is added by the
        // handwritten S2S adapter in src/client.ts (Bearer internal token).
        fetch: {
          includeHttpResponseReturnType: false,
        },
      },
    },
  },
});
