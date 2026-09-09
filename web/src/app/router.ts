import { createRouter, createWebHistory } from 'vue-router';
import HomeRouteView from '../views/HomeRouteView.vue';
import LegacyWorkbenchView from '../views/LegacyWorkbenchView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomeRouteView },
    {
      path: '/registration/:sessionId',
      name: 'registration',
      component: LegacyWorkbenchView,
      props: route => ({ sessionId: route.params.sessionId, apiVersion: 'v2' }),
    },
  ],
});
