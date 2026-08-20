import './style.css';
import { renderHome } from './pages/home';

const app = document.querySelector<HTMLDivElement>('#app')!;
const manualMatch = location.pathname.match(/^\/manual-registration\/([0-9a-f-]+)$/i);
const sessionId = new URLSearchParams(location.search).get('session') ?? manualMatch?.[1];
if (sessionId) {
  import('./pages/manual-registration').then(({ renderManualRegistration }) =>
    renderManualRegistration(app, sessionId)
  ).catch(error => {
      app.innerHTML = `<div class="loading">粗配准工作台加载失败：${String(error)}</div>`;
    });
} else {
  renderHome(app);
}
