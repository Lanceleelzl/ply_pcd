import { createRouter, createWebHistory } from 'vue-router';
import HomeRouteView from '../views/HomeRouteView.vue';
import LegacyWorkbenchView from '../views/LegacyWorkbenchView.vue';
import ToolkitHomeView from '../views/ToolkitHomeView.vue';
import StreamingView from '../views/streaming/StreamingView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: ToolkitHomeView,
      beforeEnter: to => typeof to.query.session === 'string'
        ? { name: 'registration-new', query: { session: to.query.session } } : true },
    { path: '/registration', name: 'registration-new', component: HomeRouteView },
    { path: '/streaming', name: 'streaming', component: StreamingView },
    { path: '/streaming/:taskId', name: 'streaming-task', component: StreamingView },
    {
      path: '/registration/:sessionId',
      name: 'registration',
      component: LegacyWorkbenchView,
      props: route => ({ sessionId: route.params.sessionId, apiVersion: 'v2' }),
    },
  ],
});
