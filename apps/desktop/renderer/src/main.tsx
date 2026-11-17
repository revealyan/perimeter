import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { migrateLocalStorage } from './lib/migrate';
import './styles.css';

// до первого чтения настроек: настройки времён «codecode» переезжают на новые ключи
migrateLocalStorage();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
