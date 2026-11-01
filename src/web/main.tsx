import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { ScrollRestoration } from './lib/history';
import { setupPwa } from './lib/pwa';
import { applyStoredTheme } from './lib/theme';
import './styles.css';

applyStoredTheme();
setupPwa();
// Retry network and server hiccups, but not answers like "not found" or "not allowed": those won't change, and
// retrying them left pages on "Loading…" for several seconds before the error showed.
const retry = (failures: number, error: unknown) => !(error instanceof ApiError && error.status < 500) && failures < 2;
const queryClient = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, retry } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ScrollRestoration />
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
