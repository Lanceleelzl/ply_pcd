<script setup lang="ts">
const paths = {
  map: 'm2 5 6-2 8 3 6-2v15l-6 2-8-3-6 2z M8 3v15m8-12v15',
  folder: 'M3 7V5h6l2 2h9v3 M3 9h18l-3 10H3z',
  unload: 'm12 3 9 5-9 5-9-5z M3 12l9 5 3-1.7 M3 16l9 5 M16 19h6',
  center: 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5 M12 9v6m-3-3h6',
  cube: 'M12 2 3 7v10l9 5 9-5V7z M3 7l9 5 9-5m-9 5v10',
  clip: 'M3 16 13 4h7L10 16z M3 20h18',
  layers: 'm12 3 9 5-9 5-9-5z M3 12l9 5 9-5 M3 16l9 5 9-5',
  settings: 'm10 3 4 0 .6 2.5 2 .9 2.2-.9 2 3.4-1.8 1.7v2.8l1.8 1.7-2 3.4-2.2-.9-2 .9L14 21h-4l-.6-2.5-2-.9-2.2.9-2-3.4L5 13.4v-2.8L3.2 8.9l2-3.4 2.2.9 2-.9z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  hidden: 'm3 3 18 18 M10 5c7-1 12 7 12 7l-3 4 M6 7l-4 5s5 8 13 7',
  close: 'm6 6 12 12 M18 6 6 18',
  down: 'm6 9 6 6 6-6',
};
defineProps<{ name: keyof typeof paths | 'locate' }>();
</script>
<template>
  <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <template v-if="name === 'locate'">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
    </template>
    <path v-else :d="paths[name]" />
  </svg>
</template>
