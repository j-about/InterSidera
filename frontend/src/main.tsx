import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './i18n';
import './styles/app.css';

// Guard instead of a `!` non-null assertion: strictTypeChecked forbids it (plan D19), and a missing
// mount point should fail loudly rather than as a null dereference deep inside React.
const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('#root missing');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
