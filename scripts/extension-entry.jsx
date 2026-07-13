/**
 * Extension UI entry — same React dashboard as the website, without Astro.
 * popup.html → MetaMask-style dropdown; node.html → full tab.
 */
import { createRoot } from 'react-dom/client';
import WasmBrowserNode from '../src/components/WasmBrowserNode.jsx';
import './extension-theme.css';
import '../src/components/NodeDashboard.css';

const isPopup = /popup\.html$/i.test(location.pathname);
const isSide = /sidepanel\.html$/i.test(location.pathname);
document.documentElement.classList.add('extension-shell');
if (isPopup) {
  document.documentElement.classList.add('extension-popup');
  document.body.classList.add('extension-popup');
} else if (isSide) {
  document.documentElement.classList.add('extension-sidepanel');
  document.body.classList.add('extension-sidepanel');
} else {
  document.documentElement.classList.add('extension-tab');
  document.body.classList.add('extension-tab');
}

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root missing — popup/node.html is incomplete');
}
createRoot(root).render(<WasmBrowserNode />);
