import { defineStore } from 'pinia';
import { ref } from 'vue';

const WORKSPACE_KEY = 'ply-pcd-registration-workspace-id';

export const useWorkspaceStore = defineStore('workspace', () => {
  const stored = localStorage.getItem(WORKSPACE_KEY);
  const workspaceId = ref(stored ?? crypto.randomUUID());
  if (!stored) localStorage.setItem(WORKSPACE_KEY, workspaceId.value);
  return { workspaceId };
});
