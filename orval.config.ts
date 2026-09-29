import { defineConfig } from 'orval';

export default defineConfig({
  edo: {
    input: './apps/api/openapi.json',
    output: {
      target: './packages/api-client/src/generated/api.ts',
      client: 'react-query',
      mode: 'single',
      clean: true,
      prettier: true,
      override: {
        mutator: {
          path: './packages/api-client/src/mutator/custom-instance.ts',
          name: 'customInstance',
        },
        query: {
          useQuery: true,
        },
      },
    },
  },
});
