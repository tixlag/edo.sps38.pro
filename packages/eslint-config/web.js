module.exports = {
  extends: ['./index.js'],
  env: { browser: true },
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['axios', 'node-fetch'],
            message: 'Use the generated Orval client (packages/api-client), not raw fetch/axios in components.',
          },
        ],
      },
    ],
  },
};
