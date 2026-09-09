import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'bootstrap/dist/css/bootstrap.min.css';
import './styles/tokens.css';
import './styles/global.css';
import App from './App.jsx';

// Import order matters: Bootstrap first, then tokens, then global, so our
// layer wins the cascade. Same arrangement as Project 2.
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
