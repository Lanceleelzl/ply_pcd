export function mountWorkbenchLayout(root: HTMLElement): void {
  const editor = root.querySelector<HTMLElement>('.integrated-editor')!;
  const workspace = editor.querySelector<HTMLElement>('.integrated-workspace')!;
  const workflow = workspace.querySelector<HTMLElement>('.workflow-panel')!;
  const viewport = workspace.querySelector<HTMLElement>('.viewport')!;
  const title = workflow.querySelector<HTMLElement>('.workflow-title')!;
  const steps = Array.from(workflow.querySelectorAll<HTMLElement>(':scope > .workflow-step'));
  if (steps.length !== 4) throw new Error(`工作台流程结构无效：预期 4 步，实际 ${steps.length} 步`);

  const topbar = document.createElement('header');
  topbar.className = 'workbench-topbar';
  topbar.innerHTML = '<div class="workbench-brand"><span>R</span><small>REGISTRATION STUDIO</small></div>';
  topbar.append(title);

  const workflowHeader = document.createElement('header');
  workflowHeader.className = 'dock-heading';
  workflowHeader.innerHTML = '<span>01</span><div><strong>模型与坐标</strong><small>确认输入数据和业务场景矩阵</small></div>';
  workflow.prepend(workflowHeader);

  const inspector = document.createElement('aside');
  inspector.className = 'inspector-panel';
  inspector.innerHTML = '<header class="dock-heading"><span>02</span><div><strong>配准检查器</strong><small>粗配准姿态与 ICP 参数</small></div></header>';
  inspector.append(steps[1], steps[2]);

  const resultDrawer = document.createElement('section');
  resultDrawer.className = 'result-drawer';
  resultDrawer.append(steps[3]);

  editor.prepend(topbar);
  workspace.append(viewport, inspector, resultDrawer);
}
