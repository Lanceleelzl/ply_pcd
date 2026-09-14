# 重构集成回归

## 2026-09-14：阶段 8 剩余浏览器专项

- 独立 Chrome 在 `127.0.0.1:8878` 的真实会话完成长方体「适配 A／B／全部」同轮检查。三种结果的六面投影范围分别约为 `290×506 px`、`57×110 px`、`290×506 px`；相机及粗配准矩阵保持不变，截图位于 `output/playwright/stage8-fit-{a,b,both}-20260914.png`。
- 剖切边界取点使用同像素前后复测：A 的 13 个基线命中点在启用 X 上界后得到 1 个不可见侧拒绝和 12 个可见侧命中，B 的 5 个基线点得到 4 个拒绝和 1 个命中；两轮只显示被测模型，页面异常 0。
- 资源退出检查在 mock 任务保持运行时记录 1 个画布、1 条 EventSource 和 10 个带 AbortSignal 的输入监听器；退出后全部归零，EventSource 关闭一次且 10 个监听器全部收到中止；重新进入只有 1 个画布和新一组 10 个监听器。首次 mock 路径未匹配时产生的隔离任务 `b29f494f-fff0-445c-828b-a1026d2b013b` 已正常成功，不计作最终资源断言。
- 历史相机恢复专项在拖动导航立方体改变姿态后刷新同一成功会话，刷新后的导航立方体精确恢复到初始适配姿态，画布数为 1，页面异常 0；证据为 `runtime/check-camera-restoration-20260914.cjs` 和 `output/playwright/stage8-camera-restored-20260914.png`。
- 连同已完成的十二个独立轴向手柄、旋转长方体六面拖动、Gaussian 多条件交集及 20 轮 GPU 观测，阶段 8 浏览器技术验收项已全部取得证据；用户已确认验收，相关改动已合并并推送到 `main`。

## 2026-09-14：最新 Docker 镜像续验

- 用户手动启动 Windows Docker Desktop 后确认 `running`，客户端 Windows／引擎 Linux 均为 29.2.0。首次启动的套接字错误已不再阻塞本轮验证。
- 镜像 `ply-pcd-registration:verify-current-20260914` 构建通过，独立容器 `ply-pcd-current-20260914` 位于 `http://127.0.0.1:8879`，运行目录为 `runtime/docker-current-20260914`，lifespan 关闭。健康、服务导入、合成双角色与真实端到端通过，真实 RMS 为 `0.457745013019`，容器重启数 0。
- 合成会话 `4ee004a2-9405-4f75-b682-794817df42b4` 通过 `runtime/check-workbench-docker-20260914.cjs` 的双尺寸查询锁、面板互斥与布局断言，页面异常 0。真实会话为 `57d61ec6-130d-4412-8ddd-bd71d3c8f42d`；更完整的镜像标识与工作区信息见 `STAGE8_ACCEPTANCE.md`。

## 2026-09-14：Windows 与独立 Chrome 续验

- 当前 Web 自动回归 103／103、服务 48／48、Windows CTest 1／1（33.91 秒）、类型检查及生产构建通过。Vue SFC 查询视图用例仍未计入 Node 测试；构建保留既有包体积提示。
- 隔离服务 `http://127.0.0.1:8878` 使用 `runtime/stage8-20260914` 与 Windows Worker，关闭 lifespan 清理。合成会话 `771a1e81-13de-4374-b35d-c63099ccad3e` 的 A／B RMS 为 `7.41627e-07`／`5.04159e-07`；真实会话 `5cf2b3f1-4907-46eb-b7d1-9448bc8f4343` 的 RMS 为 `0.457745013019`。正逆矩阵、四份矩阵下载和历史归档通过。
- 通过 `npx --yes --package @playwright/cli playwright-cli -s=stage8 open about:blank --browser chrome --headed` 启动独立 Chrome，打开当前会话并取得快照后执行脚本。`runtime/check-history-restore-20260914.cjs` 验证迟到成功／模拟 503 均保留人工 X＝7.250，退出画布为 0，页面异常 0。
- `runtime/check-workbench-20260914.cjs` 在真实会话验证 1440×900、1280×720 查询锁、关闭解锁、面板互斥、工具栏无横向滚动及结果矩阵组布局；页面异常 0。截图位于 `output/playwright/stage8-20260914-1440.png` 与 `output/playwright/stage8-20260914-1280.png`，1280 图已目视检查。
- `runtime/check-clipping-stage8-20260914.cjs` 验证联合／独立模式往返、A 边界与 B 长方体参数保留、编辑对象和摘要、关闭面板保留剖切、粗配准不变、退出画布 0／重进 1；页面异常 0。
- 上述剖切脚本验证状态与页面接线，不代表三维手柄、Gaussian 交集、边界像素取点或长期 GPU 测量通过。

## 2026-09-14：引擎反向依赖收尾

- 静态 AST 检查明确复现 6 处反向依赖：Application、RegistrationEngine、RegistrationScene 引用应用层 ResourceScope；ClippingStateController 引用三个视图状态模块。新增 `architecture.test.ts` 的引擎测试先失败，修复后引擎和 shared 两项通过。
- ResourceScope 的实现原样迁入 shared，应用入口仅转导出；剖切规则回归引擎状态模块，视图原入口转导出，保留现有参数、文案与返回值。新增目录约定在实施方案中记录。引擎不再直接引用 app／views／pages／stores 或 Vue。
- 60 个 Node 可执行 Web 测试文件全部通过，类型检查与 Vite 构建通过。保留既有 Worker 外部化和包体积提示；`coordinate-query-views.test.ts` 因 Vue SFC 导入未纳入 Node 通过数量。
- 最新构建由 Windows 本地 8875 服务提供，运行目录为 `runtime/docker-verify-20260913`，lifespan 关闭。真实会话 `9d3017e9-a206-4505-92e1-292038be3425` 使用 `runtime/check-clipping-boundary-20260914.cjs` 验证：联合长方体与独立 A 坐标轴／B 长方体互不覆盖，A 的 X 最大值 5 保留，切换 B 编辑和摘要正确，联合关闭不误读独立状态，重回独立模式恢复激活，关闭面板保留剖切，粗配准矩阵不变。
- 退出画布 0，重新进入恢复历史且画布为 1，页面异常 0；`check-workbench-current.cjs` 两种尺寸的查询锁、面板互斥、工具栏与矩阵组布局通过。
- 本轮未改服务和 C++，未重跑其回归；2026-09-13 容器镜像不含本轮依赖调整。三维手柄及 GPU 完整生命周期验收继续单列。

## 2026-09-13：Windows Docker Desktop 当前镜像验收

- 当前代码镜像 `ply-pcd-registration:verify-current-20260913` 在 Windows Docker Desktop 构建并通过容器合成／真实端到端，详情见 `STAGE8_ACCEPTANCE.md` 最新节。
- 浏览器地址为 `http://127.0.0.1:8877`。合成会话 `a6d65e08-7978-4b2f-9469-37a076144007` 执行 `runtime/check-workbench-current.cjs`，两种尺寸下查询锁、面板互斥、工具栏和矩阵布局通过，页面异常 0。
- 真实会话 `d79e52ac-b522-410f-aeea-93ea1d356355` 恢复 B→A 和 RMS 0.457745。`runtime/check-history-restore-docker.cjs` 复用旧脚本，仅改当前地址；迟到成功和模拟 503 均保持人工 X＝7.250 及「尚未提交」，退出画布 0，页面异常 0。
- 本轮只补容器和关键浏览器联合验证；三维专项和长期 GPU 测量未增加通过结论。

## 2026-09-13：复用独立 Chrome 流程与结果展示分层

- 独立 Chrome／Playwright CLI 经正常审批可用；首次 8875 访问为连接拒绝，启动本地服务后恢复，不能归因于浏览器策略。
- 本地 8875 使用 `runtime/docker-verify-20260913` 与 Windows Worker，关闭 lifespan 清理。原容器会话含 Linux 路径，未作为本地基线；新建合成会话 `8ca4a97b-6cf7-4638-938d-0e1fa37aa9dc`、真实会话 `9d3017e9-a206-4505-92e1-292038be3425`。
- `business_transform_e2e.py` 合成 A／B RMS 为 `7.41627e-07`／`5.04159e-07`；`--real` 为 `0.457745013019`，同时通过矩阵求逆、下载与归档断言。
- 将原 `check-history-restore.cjs` 的地址替换为本轮合成会话，另存 `runtime/check-history-restore-current.cjs`，通过 CLI `run-code --filename` 执行。恢复角色 B、方向 B→A；迟到成功／模拟 503 均保持 X＝7.250 和「尚未提交」；退出画布数 0，页面异常 0。
- `runtime/check-workbench-current.cjs` 在真实会话的 1440×900、1280×720 下验证查询期间 ICP／角色／粗配准禁用、适应全部可用、换算侧 readonly 且非 disabled、返回后解锁及剖切／原点／查询面板互斥。
- 窄工作区原来强制双列，矩阵内部需横向滚动，第二组还继承纵排间距。改为按结果区宽度自适应并排／堆叠，去除不适合网格的第二组偏移。最终两种尺寸均堆叠，无组外溢出；截图 `runtime/workbench-current-1440.png`、`runtime/workbench-current-1280.png` 已目视检查。
- `RegistrationResultPanel.vue` 的方向、标题、公式与矩阵文本生成迁入 `registration-result-presentation.ts`，复用已有 `formatMatrix`。新增正反方向独立于 ICP 角色、缺失文件矩阵、空结果、输入不变回归；类型检查、构建及 59 个可执行 Web 测试文件通过。直接依赖 Vue SFC 的查询视图测试未通过 Node 运行，不计入通过数量。
- 导航立方体旧测试仍检索相机控制器内 CSS 矩阵而失败，改为检索现有 `view-controls.ts` 和当前参数名；六轴与斜视角无反射及逆矩阵断言通过。
- Docker Desktop 启动和引擎查询尚未返回可用结果，本轮未重新构建镜像；独立六向手柄、旋转长方体、Gaussian 多半空间交集、边界取点和长期 GPU 字节测量尚未补完。

## 2026-09-12：历史结果恢复边界

- 历史结果请求迁入 API 层，最近记录筛选、业务坐标匹配与恢复条件迁入独立模块。保持仅恢复最后一条成功记录、缺少业务预变换时按单位矩阵匹配、矩阵逐项误差小于 `1e-12` 的原有规则。
- 新增 6 项自动回归，覆盖记录筛选、角色／参数传递、矩阵匹配、文件坐标拒绝恢复、迟到成功、HTTP 失败和退出。过期失败响应覆盖状态的回归先失败，统一成功／失败的当前状态检查后通过；与 API、业务矩阵状态测试合计 19 项通过。
- Vue 类型检查、Web 生产构建通过，保留已有 PlayCanvas Worker 外置及大包提示。
- 8866 服务上的真实会话 `a102d3c7-eaef-4642-9624-c13464deee8c` 恢复最近结果，移动模型为 B，方向为 B→A。
- Playwright 延迟真实结果响应，在等待期间将粗配准 X 改为 7.25；释放成功响应或模拟 503 后均保持 `7.250` 与「尚未提交」，没有覆盖用户姿态或状态。
- 结果等待期间点击「新建」，退出后画布数为 0，无页面异常；模拟 503 产生预期资源错误。自动回归另覆盖新任务运行时拒绝旧响应，浏览器本轮未提交新 ICP。
- 可复现脚本为 `runtime/check-history-restore.cjs`，通过 Playwright CLI 的 `run-code --filename` 执行；本轮未改写会话数据，未重跑 Worker 或 Docker 验收。

## 2026-09-12：业务矩阵状态拆分与粗配准输入布局

- 继续使用 8866 验证服务与保留真实会话。保存接口通过 Playwright route 模拟，未改写真实业务参数或提交 ICP。
- 业务矩阵状态新增 6 项自动回归：草稿隔离与请求载荷、非有限值／非正缩放、重复提交与失败恢复、请求返回后取消、JSON 解析时取消、禁用／退出后禁止提交。加上已有 API 7 项回归全部通过。
- 显示矩阵回归、Vue 类型检查及 Web 构建通过。构建仍提示 PlayCanvas 的 Node Worker 模块外置与大包体积，本轮未修改打包策略。
- 浏览器输入零缩放时请求数为 0；有效参数保存等待期间输入禁用，模拟非 JSON HTTP 503 后提示状态码并恢复操作。控制台唯一错误是该预期 503 资源请求。
- 模拟成功保存 A 平移 X＝12.5、B 平移 X＝0，保留 A 原有 X 旋转 −90°；移动 B 的业务局部初始平移恢复为 −12.5，其余五项为零，与业务原点差约定一致。退出后画布数为 0，无页面异常。
- 粗配准输入框在 1920／1440／1280 三种宽度下均提供 62 px 数字空间；`-123.456` 字宽约 52.78 px。截图 `runtime/refactor-input-width-20260912.png` 已人工核对，负数和三位小数完整显示。
- 复现脚本：`runtime/check-business-state.cjs`、`runtime/check-business-success.cjs`，使用 Playwright CLI 的 `run-code --filename` 执行；运行目录文件不纳入 Git。
- 本轮未重新验证后端参数落盘、完整 ICP、Gaussian 或容器运行。页面仍保留会话及结果装配，阶段 8 未宣告完成。

## 2026-09-11：场景模块迁移后的真实 ICP

- 分支：`codex/refactor-registration-workbench`，场景实现提交 `0b4a29d`。
- 独立验证服务：127.0.0.1:8866，保留运行目录 `runtime/business-wysiwyg-20260908`，关闭启动清理；未修改源文件。
- 会话：`a102d3c7-eaef-4642-9624-c13464deee8c`。A 为 3,777,901 点 Gaussian PLY，B 为 149,317 点 PCD。
- 从浏览器恢复会话，重置粗调，开启进度显示，提交真实业务坐标 ICP。参数为 RMS 阈值 0.00001、采样上限 50000、重叠率 1、种子 42，移动 B、固定 A。
- 新任务：`5698c627-5fe2-4733-a1b0-8af3b340d498`，成功；最终 RMS `0.222236119526`，点数 50000，耗时 `30.7980308` 秒，落盘 112 条迭代事件。
- 与保留基线任务 `61d25164-2221-4773-9513-b65a5f2824a8` 的 `a_to_b` 逐元素比较，最大差值为 0；`a_to_b × b_to_a` 相对单位矩阵最大绝对误差为 `1.432631790976302e-12`。
- 运行时重置被禁用、适应全部可用；完成后显示结果、完成态进度并恢复编辑。这次浏览器检查未逐帧比对全部迭代画面。

## 环境限制与尚缺覆盖

- Docker CLI 可调用，但 Docker Desktop Linux 引擎管道不存在；本次无法执行容器构建和运行验证，未修改 Docker 或系统配置。
- 尚需其他剖切方向、长方体六面／旋转、Gaussian 长方体／原点及重复释放、查询标签相机旋转／缩放回归。
- 本记录不等同于全部重构完成，也不替代用户验收与合并决定。
