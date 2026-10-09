import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { NetiflyProvider } from '@netiflyjs/react';
import { App } from './App';

// Demo-only token: swap getToken for a real auth call before using this
// against a server that requires one.
const NETIFLY_URL = import.meta.env.VITE_NETIFLY_URL ?? 'ws://localhost:8080/netifly';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <NetiflyProvider url={NETIFLY_URL} getToken={() => 'demo-user'}>
      <App />
    </NetiflyProvider>
  </StrictMode>
);
