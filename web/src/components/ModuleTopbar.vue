<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { getApiKey, setApiKey } from '../api/api-auth';

defineProps<{ title: string; mark: string }>();
const apiKey = ref(getApiKey());
const serviceState = ref('检测中');
const healthAbort = new AbortController();
let healthTimer: ReturnType<typeof setInterval> | undefined;
async function checkHealth() {
  try {
    const response = await fetch('/health', { signal: AbortSignal.any([healthAbort.signal, AbortSignal.timeout(5000)]) });
    serviceState.value = response.ok ? '服务正常' : '服务异常';
  } catch { if (!healthAbort.signal.aborted) serviceState.value = '连接失败'; }
}
onMounted(() => { void checkHealth(); healthTimer = setInterval(checkHealth, 30000); });
onUnmounted(() => { clearInterval(healthTimer); healthAbort.abort(); });
</script>

<template>
  <header class="module-topbar">
    <RouterLink class="module-brand" to="/" aria-label="返回首页" title="返回首页">
      <span class="module-mark">{{ mark }}</span><span class="module-brand-text"><strong>{{ title }}</strong><slot name="subtitle" /></span>
    </RouterLink>
    <div class="module-nav">
      <a href="/docs" target="_blank" rel="noreferrer">API 文档 ↗</a>
      <span class="module-service" :class="{ offline: serviceState !== '服务正常' }"><i />{{ serviceState }}</span>
      <details class="module-access"><summary>访问设置</summary><div class="module-access-popover">
        <label><span>API Key</span><input v-model="apiKey" type="password" autocomplete="off" placeholder="未启用鉴权时留空" @change="setApiKey(apiKey)" /></label>
        <p>用于本服务的访问鉴权与数据隔离。</p>
      </div></details>
      <div class="module-actions"><slot name="actions" /></div>
    </div>
  </header>
</template>

<style scoped>
.module-topbar { box-sizing: border-box; position: relative; z-index: 30; display: flex; align-items: center; gap: 20px; min-height: 60px; padding: 8px 24px; border-bottom: 1px solid #22364c; background: #09131f; color: #edf5ff; box-shadow: 0 6px 22px #0003; }
.module-brand { display: inline-flex; align-items: center; gap: 12px; flex: none; max-width: min(50vw, 520px); border-radius: 9px; color: #edf5ff; text-decoration: none; }
.module-brand:hover { color: #fff; }
.module-mark { display: grid; flex: none; place-items: center; width: 36px; height: 36px; border-radius: 10px; color: #07140f; background: linear-gradient(145deg, #73e3be, #31aa83); box-shadow: 0 8px 24px #2fc28e28; font: 800 18px/1 Inter, sans-serif; }
.module-brand strong { font-size: 14px; letter-spacing: .02em; white-space: nowrap; }
.module-brand-text { display: grid; gap: 2px; min-width: 0; overflow: hidden; }
.module-nav { display: flex; align-items: center; gap: 20px; margin-left: auto; color: #a8b9cd; font-size: 13px; }
.module-nav > a { color: inherit; text-decoration: none; white-space: nowrap; }
.module-nav > a:hover, .module-access summary:hover { color: #edf5ff; }
.module-service { display: inline-flex; align-items: center; gap: 7px; padding: 6px 10px; border: 1px solid #253b52; border-radius: 999px; background: #102033; white-space: nowrap; font-size: 12px; }
.module-service i { width: 7px; height: 7px; border-radius: 50%; background: #45c39a; box-shadow: 0 0 0 4px #45c39a18; }
.module-service.offline i { background: #e5af62; box-shadow: none; }
.module-access { position: relative; white-space: nowrap; }
.module-access summary { cursor: pointer; list-style: none; }
.module-access-popover { position: absolute; top: 32px; right: 0; z-index: 40; width: 290px; padding: 16px; border: 1px solid #385574; border-radius: 8px; background: #17283d; box-shadow: 0 10px 30px #0008; white-space: normal; }
.module-access-popover label { display: flex; align-items: center; gap: 8px; }
.module-access-popover input { box-sizing: border-box; width: 190px; min-width: 0; padding: 7px; border: 1px solid #385574; border-radius: 6px; color: #edf5ff; background: #0c1929; }
.module-access-popover p { margin-bottom: 0; color: #a8b9cd; font-size: 12px; }
.module-actions { display: flex; align-items: center; gap: 8px; margin-left: 4px; }
.module-actions :slotted(button), .module-actions :slotted(a) { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-height: 36px; margin: 0; padding: 7px 11px; border: 1px solid #40516a; border-radius: 7px; color: #d9e6f3; background: #17283d; font: inherit; text-decoration: none; white-space: nowrap; cursor: pointer; }
.module-actions :slotted(button:hover), .module-actions :slotted(a:hover) { border-color: #73a9d0; color: #fff; background: #1c344e; }
@media (max-width: 760px) { .module-topbar { flex-wrap: wrap; padding-inline: 12px; gap: 8px 16px; } .module-nav { flex-wrap: wrap; justify-content: flex-end; gap: 8px 12px; } }
</style>
