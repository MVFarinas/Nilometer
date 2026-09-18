/**
 * @file ESLint configuration: type-aware TypeScript rules, the documentation rules from
 * docs/development.md § Standards (audit check A2), and bans on focused or skipped tests.
 */
import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig } from "eslint/config";
import jsdoc from "eslint-plugin-jsdoc";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["node_modules/", "dist/", "coverage/"] },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // Type-aware rules resolve each file through the nearest tsconfig.json.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },

  jsdoc.configs["flat/recommended-typescript-error"],
  {
    rules: {
      // Every file opens with an @file header naming its purpose (docs/development.md § Standards).
      "jsdoc/require-file-overview": "error",
      // Every function, class, method, type, and exported constant carries TSDoc, exported or not.
      "jsdoc/require-jsdoc": [
        "error",
        {
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            MethodDefinition: true,
            ClassDeclaration: true,
            // Inline callbacks (e.g. `it("...", () => {})`) stay undocumented; named arrows do not.
            ArrowFunctionExpression: false,
            FunctionExpression: false,
          },
          contexts: [
            "VariableDeclarator > ArrowFunctionExpression",
            "VariableDeclarator > FunctionExpression",
            "TSInterfaceDeclaration",
            "TSTypeAliasDeclaration",
            "TSEnumDeclaration",
            "PropertyDefinition",
            // Matches the export wrapper, which is where the TSDoc block above `export const` attaches.
            "ExportNamedDeclaration[declaration.type='VariableDeclaration']",
          ],
        },
      ],
      "jsdoc/require-description": "error",
      "jsdoc/require-param": "error",
      "jsdoc/require-returns": "error",
      "jsdoc/require-throws": "error",
    },
  },

  {
    files: ["tests/**/*.ts"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      // An `.only` or `.skip` left behind silently shrinks the suite, so both fail the audit.
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
    },
  },

  {
    // Plain JavaScript config files are not part of any tsconfig, so type-aware rules are off.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
