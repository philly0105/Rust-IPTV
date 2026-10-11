import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@/i18n';

import { Harness } from './Harness';

import.meta.glob('../../../styles/globals.css', { eager: true });

const root = document.getElementById('root');
if (root && new URLSearchParams(location.search).get('harness') === 'player') {
  createRoot(root).render(
    <StrictMode>
      <Harness />
    </StrictMode>,
  );
} else if (root) {
  root.textContent = 'Add ?harness=player to the URL.';
}
