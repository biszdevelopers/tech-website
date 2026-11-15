import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: [
            "dist/**",
            "node_modules/**",
            "public/js/vendor/**",
            "tests/baseline/**",
            "scripts/dump-baseline.mjs",
            "postcss.config.cjs",
            "prisma/*.db*",
            "var/**",
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts", "**/*.tsx"],
        rules: {
            "no-undef": "off",
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": [
                "warn",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/no-explicit-any": "warn",
            "prefer-const": "error",
            "no-var": "error",
        },
    },
    {
        files: ["src/client/**/*.ts"],
        languageOptions: {
            globals: {
                window: "readonly",
                document: "readonly",
                localStorage: "readonly",
                navigator: "readonly",
                fetch: "readonly",
                FormData: "readonly",
                URLSearchParams: "readonly",
            },
        },
    },
    {
        files: ["**/*.mjs", "**/*.cjs"],
        rules: {
            "no-undef": "off",
            "no-unused-vars": "warn",
        },
    }
);
