import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { setApiBaseUrl } from '@edo/api-client/src/mutator/custom-instance';
import { App } from './app/App';
import './index.css';

setApiBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
