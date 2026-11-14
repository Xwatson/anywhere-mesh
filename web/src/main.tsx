import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App, { shareToken } from './App';
import './index.css';
import { registerServiceWorker } from './lib/push';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker is for the app's own push notifications; people opening a shared link don't need it.
if (!shareToken) registerServiceWorker();
