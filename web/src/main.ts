import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './app/router';
import './style.css';
import './workspace-theme.css';
import './business-transform.css';
import './styles/app.css';

createApp(App).use(createPinia()).use(router).mount('#app');
