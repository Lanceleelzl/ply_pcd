import './style.css';
import './workspace-theme.css';
import { renderHome } from './pages/home';

const app = document.querySelector<HTMLDivElement>('#app')!;
const manualMatch = location.pathname.match(/^\/manual-registration\/([0-9a-f-]+)$/i);
const sessionId = new URLSearchParams(location.search).get('session') ?? manualMatch?.[1];
if (sessionId) {
  const isV2 = new URLSearchParams(location.search).get('api') === 'v2';
  const render = isV2
    ? import('./pages/generic-registration').then(module => module.renderGenericRegistration(app, sessionId))
    : import('./pages/manual-registration').then(module => module.renderManualRegistration(app, sessionId));
  render.catch(error => {
      app.innerHTML = `<div class="loading">粗配准工作台加载失败：${String(error)}</div>`;
    });
} else {
  renderHome(app);
}
