<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import HomeView from './HomeView.vue';
import LegacyWorkbenchView from './LegacyWorkbenchView.vue';

const route = useRoute();
const legacySessionId = computed(() => typeof route.query.session === 'string' ? route.query.session : '');
</script>

<template>
  <LegacyWorkbenchView
    v-if="legacySessionId"
    :key="`v2-${legacySessionId}`"
    :session-id="legacySessionId"
    api-version="v2"
  />
  <HomeView v-else />
</template>
