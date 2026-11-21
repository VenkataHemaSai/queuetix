import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.cache/**",
      ".agent-local/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs,jsx}"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["client/src/**/*.{js,jsx}"],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z]" }],
    },
  },
  {
    files: ["**/*.test.js"],
    languageOptions: { globals: globals.jest },
  },
  prettier,
];
