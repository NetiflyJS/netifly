module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'node_modules'],
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  rules: {
    // Lets `const { key: _key, ...rest } = obj;` omit a property without
    // flagging the discarded binding — the standard way to drop one field
    // from an object via destructuring.
    '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
  },
  overrides: [
    {
      // @netiflyjs/client ships browser-facing code built on the standard
      // WebSocket global, so its source needs browser globals (WebSocket,
      // CloseEvent, MessageEvent, ...) *in addition to* the repo-wide node
      // env above — its own tests still run in Node.
      files: ['packages/client/src/**/*.ts'],
      env: { browser: true },
    },
    {
      // @netiflyjs/react's hooks and the example app that exercises them
      // are browser-facing React/JSX, with the hooks-correctness rules
      // (exhaustive-deps, rules-of-hooks) that don't apply anywhere else.
      files: ['packages/react/src/**/*.{ts,tsx}', 'examples/react/src/**/*.{ts,tsx}'],
      env: { browser: true },
      plugins: ['react-hooks'],
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
  ],
};
