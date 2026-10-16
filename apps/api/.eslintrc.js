module.exports = {
  extends: ["@edo/eslint-config/node.js"],
  overrides: [
    {
      files: ["src/documents/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: ["*surveys*", "**/surveys/**"] },
        ],
      },
    },
  ],
};
