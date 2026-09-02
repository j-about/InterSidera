// jest-dom matchers on Vitest's `expect` (jest-dom 7 exposes them at the `/vitest` subpath).
import '@testing-library/jest-dom/vitest';
// Initialise i18next once per worker so components render the real en.json strings.
import '../i18n';
