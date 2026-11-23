import path from 'node:path';
import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const nestFiles = [
  'apps/api/src/**/*.{module,controller,service,guard,interceptor,pipe,filter,gateway,processor}.ts',
  'apps/worker/src/**/*.{module,controller,service,guard,interceptor,pipe,filter,gateway,processor}.ts',
  'apps/api/src/**/dto/*.ts',
  'apps/api/src/**/*.dto.ts',
  // classes declared next to controllers only to feed createZodDto
  'apps/api/src/**/*.controller.ts',
];

const webLayers = ['app', 'pages', 'widgets', 'features', 'entities', 'shared'];
const webElements = [
  { type: 'next-routes', pattern: 'apps/web/app', mode: 'folder' },
  ...webLayers.map((layer) => ({
    type: layer,
    pattern: layer === 'shared' ? 'apps/web/src/shared' : `apps/web/src/${layer}/*`,
    mode: 'folder',
  })),
];

const below = {
  'next-routes': ['app', 'pages', 'widgets', 'features', 'entities', 'shared'],
  app: ['pages', 'widgets', 'features', 'entities', 'shared'],
  pages: ['widgets', 'features', 'entities', 'shared'],
  widgets: ['features', 'entities', 'shared'],
  features: ['entities', 'shared'],
  entities: ['shared'],
  shared: [],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/generated/**',
      '**/next-env.d.ts',
      'packages/core/prisma/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': 'allow-with-description' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Input validation and header-injection defenses legitimately match control characters.
      'no-control-regex': 'off',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ClassDeclaration',
          message: 'Classes are only allowed for NestJS constructs.',
        },
        { selector: 'ClassExpression', message: 'Classes are only allowed for NestJS constructs.' },
        { selector: 'ThisExpression', message: '`this` is only allowed in NestJS constructs.' },
      ],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Only config/env.ts files may read process.env.',
        },
      ],
      'no-restricted-exports': ['error', { restrictDefaultExports: { direct: true } }],
    },
  },
  // Nest constructs may use classes and `this`.
  {
    files: nestFiles,
    rules: { 'no-restricted-syntax': 'off' },
  },
  // Only env modules read process.env.
  {
    files: [
      '**/config/env.ts',
      '**/config/env.*.ts',
      '**/*.config.{ts,mjs}',
      'apps/web/next.config.ts',
      '**/*.spec.ts',
      '**/test/**',
      'apps/web/e2e/**',
      'packages/core/prisma.config.ts',
    ],
    rules: { 'no-restricted-properties': 'off' },
  },
  // Default exports: Next route files and tool configs only.
  {
    files: [
      'apps/web/app/**/{page,layout,loading,error,not-found,template,default}.tsx',
      'apps/web/next.config.ts',
      '**/*.config.{ts,mjs}',
      'packages/core/prisma.config.ts',
    ],
    rules: { 'no-restricted-exports': 'off' },
  },
  // Business-time and SLA math live only in packages/shared.
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'luxon', message: 'Time-zone math belongs in packages/shared.' }] },
      ],
    },
  },
  // Feature-Sliced Design boundaries for the web app.
  {
    files: ['apps/web/app/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': webElements,
      'boundaries/include': ['apps/web/app/**/*', 'apps/web/src/**/*'],
      'import/resolver': {
        typescript: { project: path.join(import.meta.dirname, 'apps/web/tsconfig.json') },
      },
    },
    rules: {
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: Object.entries(below).map(([from, allow]) => ({ from: [from], allow })),
        },
      ],
      'boundaries/entry-point': [
        'error',
        {
          default: 'disallow',
          rules: [
            { target: ['pages', 'widgets', 'features', 'entities'], allow: 'index.{ts,tsx}' },
            { target: ['shared', 'app', 'next-routes'], allow: '**' },
          ],
        },
      ],
    },
  },
);
