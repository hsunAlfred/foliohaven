import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';
import './editor-preview.css';

const root = document.getElementById('root');
if (!root) throw new Error('工作室掛載入口不存在。');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
