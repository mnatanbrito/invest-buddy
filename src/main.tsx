import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';

/** Follow the OS colour scheme; the diagram defines a palette for both. */
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (isDark: boolean) => document.documentElement.classList.toggle('dark', isDark);
applyTheme(dark.matches);
dark.addEventListener('change', (event) => applyTheme(event.matches));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
