// T002: ESLint flat config（TypeScript strict + Prettier 兼容）
import js from "@eslint/js"
import tseslint from "typescript-eslint"
import prettier from "eslint-config-prettier"

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "build/**",
      ".plasmo/**",
      "resources/**",
      "coverage/**",
      "*.config.js",
      "*.config.cjs"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/no-explicit-any": "error",
      "no-console": "off"
    }
  },
  {
    files: ["**/*.mjs", "**/*.cjs", "scripts/**", ".prettierrc.cjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        module: "readonly",
        require: "readonly",
        __dirname: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    }
  }
)
