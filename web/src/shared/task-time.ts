export function formatTaskTime(unix?: number | null): string {
  return typeof unix === 'number' && Number.isFinite(unix) && unix > 0
    ? new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false }) : '未知';
}
