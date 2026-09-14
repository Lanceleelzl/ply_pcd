# 阶段 8 验收清单

## 2026-09-14 三维剖切与 GPU 专项续验

- 独立剖切脚本分别切换模型 A、B，逐一拖动 `−X／+X／−Y／+Y／−Z／+Z` 十二个轴向手柄；每次仅对应模型的对应边界值变化并自动启用，另一模型、联合范围、粗配准矩阵和相机姿态不变。脚本为 `runtime/check-independent-axis-20260914.cjs`，起始画面为 `runtime/independent-axis-start-20260914.png`。
- 联合长方体在旋转后完成六个面逐面拖动；当前面沿对面方向移动，成对的另一面保持不动，粗配准矩阵和相机姿态不变。脚本只在六面断言全部通过后写出 `runtime/rotated-box-six-faces-20260914.png`。旋转及 Gaussian 多条件交集画面分别为 `runtime/box-rotated-success-20260914.png`、`runtime/gaussian-rotated-box-only-20260914.png`、`runtime/gaussian-box-minus-x-20260914.png`、`runtime/gaussian-box-minus-x-plus-y-20260914.png` 和 `runtime/gaussian-intersection-20260914.png`；画面确认完整 A Gaussian 依次叠加旋转长方体和两个原点半空间后继续取交集。
- 连续执行 20 轮「加载完整 A Gaussian→启用长方体剖切→切回中心点」，四批脚本结果均为 5／5 且页面异常 0，记录位于 `runtime/gpu-cycles-1-20260914.txt` 至 `runtime/gpu-cycles-4-20260914.txt`。GPU Dedicated Usage 在首次加载前约 110 MiB，首次释放后进入约 273～293 MiB 的缓存平台；20 轮常规峰值约 451～455 MiB，另有两次约 618～625 MiB 的瞬时峰值。第 20 轮释放后连续 12.7 分钟的 371 个样本稳定为 272.9 MiB，没有逐轮增长。采样原始数据为 `runtime/gpu-memory-20260914.jsonl`。
- 结论边界：本轮未观察到随加载／释放轮次持续增长的 GPU 显存泄漏，但进程没有回到冷启动基线，现有数据支持“一次性缓存后稳定”，不支持“释放后归零”。旧 `runtime/check-clipping-boundary-20260914.cjs` 只覆盖状态切换；实际边界两侧取点由下述新脚本另行验证。
- 同一真实会话依次执行「适配 A」「适配 B」「适配全部」，六面投影范围分别约为 `290×506 px`、`57×110 px`、`290×506 px`；A 的范围包含 B，因此适配全部与适配 A 一致。三次均保持相机与粗配准矩阵不变，画面见 `output/playwright/stage8-fit-{a,b,both}-20260914.png`，断言脚本为 `runtime/check-fit-modes-20260914.cjs`。
- 剖切边界两侧实际取点已分别针对 A、B 执行。脚本先在关闭边界时记录同像素基线，再按已命中点的显示世界 X 中值启用上界并复测：A 为 13 个基线点、1 个不可见侧拒绝、12 个可见侧命中；B 为 5 个基线点、4 个拒绝、1 个命中。两轮只显示被测模型，页面异常 0；脚本及画面为 `runtime/check-boundary-picking-20260914.cjs`、`output/playwright/stage8-boundary-picking-{a,b}-20260914.png`。
- 退出资源联合验收在 mock 任务保持运行、过程显示已开启时执行。运行中为 1 个画布、1 条 EventSource 和 10 个带 AbortSignal 的输入监听器；退出后画布与活动 EventSource／监听器均为 0，EventSource 关闭 1 次，10 个监听器全部随信号中止；重新进入后为 1 个画布、新建 10 个监听器且无 EventSource。页面异常 0，脚本与重进画面为 `runtime/check-exit-resources-20260914.cjs`、`output/playwright/stage8-resource-reentry-20260914.png`。首次拦截规则未匹配时在隔离运行目录实际提交了任务 `b29f494f-fff0-445c-828b-a1026d2b013b`，该任务随后正常成功；最终资源断言使用修正后的 mock 请求，不依赖任务完成速度。
- 历史相机恢复专项先记录成功结果加载后的适配视角，拖动导航立方体确认相机姿态发生变化，再刷新同一会话；刷新后历史结果恢复，导航立方体精确回到原适配姿态且画布数为 1。页面异常 0，脚本和画面为 `runtime/check-camera-restoration-20260914.cjs`、`output/playwright/stage8-camera-restored-20260914.png`。

## 2026-09-14 当前代码范围

引擎依赖边界调整已通过 60 个可执行 Web 测试文件中的 103 项回归、类型检查、构建、本地真实会话剖切状态切换和退出／重进回归；独立 Chrome 页面异常 0，画布退出 0／重进 1。服务 48／48、Windows CTest 1／1（33.91 秒）及合成／真实端到端通过。Windows 隔离服务为 `127.0.0.1:8878`，运行目录为 `runtime/stage8-20260914`，真实 RMS 为 `0.457745013019`。细节见 `refactor-integration-regression.md` 最新节。A／B 独立六向手柄、旋转长方体六面拖动、三种范围适配、Gaussian 多条件交集、剖切边界两侧取点、退出资源联合检查和 20 轮 GPU 测量均已补齐。

### Docker Desktop 启动记录

首次 `docker desktop start` 后，后端日志在 `2026-09-14T00:19:04Z` 记录 `initializing Inference manager` 时 `dockerInference` 套接字无法访问并退出；等待命令随后中断。之后用户明确告知已手动启动 Docker，当前 `docker desktop status` 为 `running`，Windows 客户端与 Linux 引擎均为 29.2.0。恢复归因按用户手动启动记录，不归因于同时尝试的直接程序启动命令。未删除 Docker 文件、重置或修改系统配置。

## 2026-09-14 最新容器复验通过

- 镜像 `ply-pcd-registration:verify-current-20260914` 构建成功，ID 为 `sha256:80721c9c5874a5a106e145160367326e6bc74ec67e1d99ba3bffe6ab908db379`，包含本轮引擎依赖调整。
- 独立容器 `ply-pcd-current-20260914` 使用 `127.0.0.1:8879` 与 `runtime/docker-current-20260914`，关闭 lifespan 清理，重启数 0。内外健康检查与 `service.app`、`service.cleanup`、`service.session_state` 导入通过。
- 合成 A／B RMS 为 `7.41627e-07`／`5.04159e-07`；真实 RMS 为 `0.457745013019`。正逆矩阵、四份矩阵下载和历史归档断言通过。合成会话为 `4ee004a2-9405-4f75-b682-794817df42b4`，真实会话为 `57d61ec6-130d-4412-8ddd-bd71d3c8f42d`，真实工作区为 `89ba148f-270d-4e72-b4b1-87b542c10458`。
- 独立 Chrome 的容器合成页面通过 1440×900／1280×720 查询锁、关闭解锁、面板互斥、工具栏和矩阵组布局检查，页面异常 0。脚本 `runtime/check-workbench-docker-20260914.cjs`，输出 `runtime/docker-browser-layout-20260914.log`。
- 本轮仅补验证与验收文档状态，未修改业务代码、Docker 配置或系统配置，未合并或推送。三维专项和长期 GPU 观测仍待完成。

## 2026-09-13 Windows Docker Desktop 镜像复验记录

- 2026-09-13 后续：已确认 Windows Docker Desktop 桌面进程正常响应，`docker desktop status` 返回 running；Desktop 4.60.0，客户端 `windows/amd64`、托管引擎 `linux/amd64`，均为 29.2.0。本节替代下方关于当前 Docker 尚未就绪的历史描述。
- 当前源码镜像 `ply-pcd-registration:verify-current-20260913` 构建成功，包含最新结果展示模块和自适应矩阵布局。镜像 ID 为 `sha256:d1b6ae9dd44ef6a8209cea791e54e2d542948a094e0bfa352852f16d1bf405e6`；Web 构建、C++ 72 步编译和服务导入均通过。
- 独立容器 `ply-pcd-current-20260913` 使用 `127.0.0.1:8877` 与 `runtime/docker-current-20260913`，禁用 lifespan 自动清理，未复用含 Windows 路径的会话。容器保持运行，重启数 0。内外 `/health` 均成功；`service.app`、`service.session_state`、`service.cleanup` 可导入。
- 容器合成 A／B 双角色 RMS 为 `7.41627e-07`／`5.04159e-07`；真实 PLY／PCD RMS 为 `0.457745013019`，与本地基线一致。正逆矩阵、四份矩阵下载、历史归档断言均通过。
- 合成会话 `a6d65e08-7978-4b2f-9469-37a076144007`，真实会话 `d79e52ac-b522-410f-aeea-93ea1d356355`，真实工作区 `dce4db04-a6f7-4b5c-9b1c-023bc48ac7e9`。
- 独立 Chrome 的容器合成页面通过 1440×900／1280×720 查询锁、只读结果、关闭解锁、面板互斥、工具栏无横向滚动及矩阵组堆叠检查。真实页面恢复 B→A 与 RMS，复用 `runtime/check-history-restore-docker.cjs` 验证迟到成功／503 不覆盖 X＝7.250、退出画布数 0，页面异常 0。503 为脚本主动模拟的预期请求错误。
- 本轮未改业务代码、Docker 配置或系统配置，未发布镜像，未合并／推送。剩余三维手柄、Gaussian 交集、边界取点及长期 GPU 字节测量仍待验证，阶段 8 未完成。

## 当前结论：独立 Chrome 通道已验证（2026-09-13 后续）

本节优先于下方历史环境记录。独立 Chrome／Playwright CLI 经正常审批可用，8875 首次失败是服务未监听；本轮启动本地隔离服务后，已在真实会话完成查询锁、面板互斥与 1440×900／1280×720 布局回归，合成会话完成历史迟到响应及退出画布清理回归。页面异常为 0。详见 `docs/refactor-integration-regression.md` 最新记录。

服务 48／48、Windows CTest 1／1、59 个可由 Node 执行的 Web 测试文件、类型检查、生产构建和本地合成／真实端到端通过。真实 RMS 为 `0.457745013019`。最终代码包含结果展示分层与窄结果区自适应布局修复。

剩余三维手柄、旋转长方体／Gaussian 交集、边界取点与长期 GPU 测量状态是「待验证」，不再标为浏览器权限阻塞。退出画布为 0 不等于监听器、SSE 和 GPU 全部资源验收完成。Docker Desktop 本轮启动／查询未取得可用结果，当前构建未完成容器复验。阶段 8 仍进行中。

## 可复用验证方式与证据边界

- 宿主机为 Windows。先确认 Docker Desktop 与 `desktop-linux` 引擎状态；引擎管道不存在时检查 Desktop 是否启动，不直接判定为权限不足。
- 历史成功页面验收使用 Playwright CLI 驱动独立 Chrome（用户确认），不是 Codex 内置浏览器。脚本为 `runtime/check-history-restore.cjs`、`runtime/check-business-state.cjs`、`runtime/check-business-success.cjs`，成功证据见 `docs/refactor-integration-regression.md`。复用前核对当前服务地址、会话、页面快照及断言；脚本中的 8866 和历史会话不能直接当作当前环境。
- 内置浏览器失败不等于 Chrome 或 Playwright 故障；CLI 版本检查也不等于真实页面验收。当前有明确安全访问拒绝时，不切换通道绕过，应先恢复校验。
- 历史容器验收通过不代表服务持续运行；重启应用或恢复任务后先确认健康检查。2026-09-13 后续检查曾再次发现 Desktop 引擎未运行。
- 用户已要求将上述方式保存为记忆更新说明；今后优先按此核对历史证据，不能重复混淆宿主机、容器引擎与浏览器通道。

## 最新复验：Windows Docker Desktop（2026-09-13）

- 宿主机为 Windows；通过 `docker desktop start` 启动本机 Docker Desktop 4.60.0。客户端为 `windows/amd64`，其托管的 Linux 容器引擎为 29.2.0 `linux/amd64`，不需要 Linux 宿主机。
- 当前代码镜像 `ply-pcd-registration:verify-20260913` 构建通过，镜像 ID 为 `sha256:2e09ae1039cb60100dea6e2b88636fdca12aa398823a3026140ce29b78e06790`。构建包含 Web、72 步 C++ Worker 编译与 `import service.app` 检查。
- 独立测试容器 `ply-pcd-verify-20260913` 绑定 `127.0.0.1:8875`，专用运行目录为 `runtime/docker-verify-20260913`，使用 `--lifespan off` 避免清理已有数据。容器保持运行，未修改其他项目容器。Desktop 启动时按原有策略自动恢复了已有容器。
- `/health` 返回 `{"status":"ok"}`，首页 HTTP 200；容器内 `service.app`、`service.session_state`、`service.cleanup` 导入通过，容器重启数为 0。
- 合成 A／B 双角色端到端通过，RMS 为 `7.41627e-07`／`5.04159e-07`；真实 PLY／PCD 为 `0.457745013019`。矩阵求逆、文件矩阵下载及历史归档均通过。真实会话为 `7c52d6dd-b42f-49f2-88a3-39ce489b922a`，工作区为 `d7234a8d-6189-483d-a3a7-15fbefc8ad0b`。
- Windows CTest 1／1（35.62 秒）及可由 Node 加载的 Web 回归 98／98 通过；直接依赖 Vue SFC 的查询视图测试仍不纳入 Node 执行数量。
- 浏览器重新访问 `http://127.0.0.1:8865` 仍被管理员策略校验不可用拒绝，未换通道绕过。因此下方浏览器联合、三维视觉及长期 GPU 验收仍未完成。

## 本轮续作验证（2026-09-13）

- 服务回归 48／48 通过，包含会话状态提取的 8 项用例及周期清理调度的 2 项异步用例。
- Web 类型检查和生产构建通过，仍有既有 PlayCanvas Worker 外部化和大包提示。
- 本地隔离服务 8876：合成 A／B 双角色 RMS 为 `7.41627e-07`／`5.04159e-07`，真实 PLY／PCD 为 `0.457745013019`，矩阵求逆、文件矩阵下载与历史归档全部通过。真实会话为 `32f0a0cb-0b55-4ae6-a2a7-705145bb2a45`，运行目录为 `runtime/refactor-check-20260913`。
- 验收服务使用 `--lifespan off`，未运行真实目录清理；周期调度由异步隔离测试验证，不能视为启动清理的运行验收。
- Docker CLI 29.2.0 可执行；正常权限提升后配置可读，但 `dockerDesktopLinuxEngine` 管道不存在，当前镜像构建与容器复验未执行。
- Playwright CLI 0.1.19 经正常权限提升可运行；默认沙箱执行 npx 时 npm 缓存写入收到 EPERM。CLI 版本检查不能证明浏览器启动和页面交互可用。
- 内置浏览器工具可列出浏览器，但访问 `http://127.0.0.1:5173` 被管理员策略校验不可用拒绝；未通过 Playwright 或其他路径绕过，以下浏览器与 GPU 验收仍待补。

## 上轮暂跳过的验证（历史记录，服务与本地端到端已于本轮补验）

2026-09-13：用户要求先推进其他代码重构，验证后续补做。本轮 `service/session_state.py` 提取与 `service/app.py` 接线为「已实现／待验证」，以下项目暂跳过，尚未执行；此处是用户安排的延期，与下方权限阻塞分开记录。

- `pnpm run test:service`：包含新增 8 项会话状态用例，覆盖同步字段、终态隔离、归档顺序和失败、缺少记录、链接规范化及源文件判断；同时重跑原有 API 迁移、任务、会话、历史和清理回归。
- 合成业务坐标 A／B 双角色及真实数据端到端：确认任务结束后会话状态与历史结果正确落盘。
- Docker 镜像构建与容器服务／端到端：确认新 Python 模块随服务打包且可导入。

本轮未修改 Web 或 C++，未重跑其检查。下方自动回归数量和 Docker 通过记录均为本轮迁移前的历史证据，不能作为当前版本验收结论。

## 自动回归基线

以下结果已于 2026-09-13 在 `codex/refactor-registration-workbench` 验证：

- 可由 Node 直接加载的 Web TypeScript 回归 98／98。
- `pnpm run typecheck:web` 通过。
- `pnpm run build:web` 通过，仅有既有 PlayCanvas Worker 外部化和大包提示。
- `pnpm run test:service` 通过，38／38。
- `pnpm run test` 通过，Windows CTest 1／1。
- 合成业务坐标端到端在 A、B 两种移动角色下通过；真实 PLY／PCD 端到端 RMS 为 `0.457745013019`。
- `git diff --check` 通过。

## 2026-09-14 进度订阅生命周期自动回归

- `RegistrationJobController.test.ts` 新增关闭／重开进度订阅、旧连接迟到 iteration／terminal、父信号中止及禁止中止后重开连接的组合回归。先复现旧迭代污染当前进度，再以连接身份校验修复；专项 5／5 通过。
- Web 可执行回归 104／104、类型检查与生产构建通过。执行结果位于 `runtime/stage8-sse-tests.log`；依赖 Vue SFC 的 `coordinate-query-views.test.ts` 未纳入 Node 测试数量。构建保留 PlayCanvas Worker 外部化和大包提示。
- EventSource 采用测试替身，并主动模拟已关闭连接的迟到回调；这证明控制器隔离及中止逻辑，不证明真实浏览器的事件调度、监听器或 GPU 资源均无残留。本轮未新增浏览器或 Docker 验收结论。

## 浏览器联合验收

当前状态：已通过。独立 Chrome／Playwright CLI 已完成下表全部联合专项，不再沿用内置浏览器的历史权限阻塞结论。

| 状态 | 项目 |
| --- | --- |
| 已通过刷新前后相机姿态断言 | 历史结果、角色、ICP 参数、业务矩阵、RMS 与相机恢复 |
| 已通过双分辨率回归 | 坐标查询锁定与关闭后解锁 |
| 已通过双分辨率回归 | 剖切、原点平面、坐标查询互斥及面板切换 |
| 已通过真实三维拖动 | 独立剖切 A／B 六向手柄隔离 |
| 已通过同轮画面与状态断言 | 旋转长方体、六面拖动与三种范围适配 |
| 已通过真实 Gaussian 画面组合 | Gaussian 与旋转长方体、多原点平面交集 |
| 已通过同像素边界两侧复测 | 剖切边界附近 A／B 坐标取点 |
| 已通过联合资源计数；Gaussian 另由 20 轮实测覆盖 | 退出重进后的画布、监听器、EventSource 与 Gaussian 资源释放 |

确认当前服务健康与会话可用后，在 1440×900 和 1280×720 各执行一次以下主流程：

1. 打开一个已有成功结果的 v2 会话，确认历史角色、ICP 参数、业务矩阵、RMS 和相机适配恢复。
2. 开启坐标查询，确认 ICP、角色、粗配准和参数编辑锁定；剖切与相机操作仍可用。关闭查询后所有编辑恢复。
3. 依次切换剖切、原点平面和坐标查询，确认冲突工具关闭、工具栏激活态同步，关闭面板不清除已生效剖切。
4. 在独立剖切中分别编辑 A、B 的 −X／±Y／±Z 手柄，确认只回写当前模型的当前边界，另一模型、联合范围和粗配准矩阵不变。
5. 旋转长方体后拖动六面并执行「适配 A」「适配 B」「适配两者」，确认手柄沿面法线移动，画面边界与包围盒一致。
6. 加载完整 A Gaussian，组合旋转长方体与两个以上原点半空间，确认画面取交集；切回中心点后剖切状态保留。
7. 在剖切边界附近分别执行 A、B 场景取点，确认不可见侧不能命中、可见侧可以命中，业务坐标换算保持双精度结果。
8. 退出工作台并重新进入，确认旧画布、监听器、EventSource 和 Gaussian 资源已释放，重新进入只有一个画布且历史结果仍可恢复。

验收期间记录浏览器控制台错误、画布数量、关键状态值和必要截图。三维操作必须按当前投影位置重新定位手柄，不能复用历史固定坐标。

## 长期 GPU 资源验收

当前状态：已完成 20 轮浏览器实测。首次加载后显存进入一次性缓存平台，之后各轮释放值没有持续增长；第 20 轮释放后连续 12.7 分钟稳定为 272.9 MiB。该结果证明本轮未观察到长期增长趋势，但不表示进程回到冷启动基线。

连续执行至少 20 轮「加载完整 Gaussian→启用剖切→切回中心点」，每轮等待加载和释放完成。记录浏览器进程 GPU 内存基线、峰值及释放后稳定值；单次 `deleteTexture`／`deleteBuffer` 调用只能证明释放路径被调用，不能单独证明无长期泄漏。

## Docker Linux 验收

当前状态：当前代码复验已完成。Windows Docker Desktop 启动后，镜像构建、容器健康、新服务模块导入与合成／真实数据端到端均通过，详见本文最新复验记录。此前引擎管道不存在的阻塞已解除。

2026-09-13 已完成：Linux 镜像构建、镜像内 `import service.app`、容器健康、合成 A／B 双角色及真实 PLY／PCD 端到端均通过，真实 RMS 为 `0.457745013019`。验证容器使用独立宿主端口 8875，完成后已停止，镜像和运行数据保留。

Docker Engine 可用后执行：

```powershell
pnpm run docker:build
pnpm run docker:up
```

确认容器健康后，针对容器 API 运行合成与 `--real` 两轮 `tests/service/business_transform_e2e.py`。完成后可按项目文档执行 `pnpm run docker:down`；该命令会停止并移除项目容器和 Compose 网络，执行前按项目红线取得用户确认。

## 验收结论

浏览器联合验收、长期 GPU 资源验收和 Docker Linux 验收均已留下有效证据。阶段 8 技术验收项已完成，等待用户验收决定；合并或推送到 `main` 仍需用户明确授权。
