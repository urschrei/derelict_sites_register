export default [
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        d3: "readonly",
        maplibregl: "readonly",
        turf: "readonly",
      },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "error",
      "no-var": "error",
      "prefer-const": "error",
      eqeqeq: ["error", "smart"],
    },
  },
];
