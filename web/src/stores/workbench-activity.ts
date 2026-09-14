import { reactive } from 'vue';

export function createWorkbenchActivity() {
  const state = reactive({
    running: false,
    queryActive: false,
    cancelling: false,
    progress: false,
    get editingLocked(): boolean { return this.running || this.queryActive; },
  });
  const setRunning = (running: boolean) => {
    state.running = running;
    state.cancelling = false;
  };
  return { state, setRunning };
}
