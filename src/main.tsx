import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { initI18n } from '@/i18n';
import { bindWindowFullscreen } from '@/api/window';
import { App } from './App';

// U1 owns src/styles/globals.css. Loaded via glob so the build passes before it exists.
import.meta.glob('./styles/globals.css', { eager: true });

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

bindWindowFullscreen();

// Render only once the remembered language is loaded and active, so a
// non-English user never sees an English first frame. initI18n never rejects:
// a failed locale load falls back to English.
void initI18n().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
