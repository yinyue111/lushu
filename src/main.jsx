import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import 'leaflet/dist/leaflet.css';
import './styles/global.css';
import './styles/components.css';

createRoot(document.getElementById('root')).render(<App />);
