import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import tseslint from 'typescript-eslint'

// Deliberately minimal. This config exists to enforce the security rules from FLEET_CONNECTIVITY.md,
// not to impose a full style guide - formatting stays out of scope. The key rule is `vue/no-v-html`:
// v-html is the main XSS vector in a Vue app. No credential is readable by script any more - the
// access token is in memory and the refresh token is an HttpOnly cookie - but script on the page can
// still act as the operator for as long as the tab is open, so keeping it out remains the point.
export default tseslint.config(
  { ignores: ['dist', 'src/api/schema.d.ts'] },
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      // Ban raw HTML injection outright rather than warning.
      'vue/no-v-html': 'error',
      // These are opinionated formatting rules the recommended set turns on; leave layout to the
      // editor and keep the linter focused on correctness and safety.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/html-indent': 'off',
      'vue/attributes-order': 'off',
      // Optional props (`icon?`, `placeholder?`) are intentionally optional; a default is noise.
      'vue/require-default-prop': 'off',
    },
  },
)
