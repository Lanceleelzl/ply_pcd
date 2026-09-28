# 阶段 14：高斯工具箱执行清单

## 续作入口

- 用户已确认整体方案并授权编码，不需要重新询问是否实施。
- 分支：`codex/gaussian-toolkit`。基线：`450f952e34d595fda99ce7ddbcfb13a8c8ed50dc`（开始时工作区干净）。不得在 main 直接实施，不推送、不改 CI/CD、不删除旧数据。
- 先读 `CLAUDE.md`、`ROADMAP.md` 与本文件，再运行 `git status --short` 检查已完成的未提交改动。不要因会话中断重做、覆盖或回滚已有工作。
- 状态约定：`[ ]` 未完成，`[-]` 进行中／已编码待验证，`[x]` 已实现并通过对应验证。每个里程碑后同步本文件和 ROADMAP，记录实际命令、结果、阻塞与下一步。
- 当前断点：2026-09-28 官方源构建修复、最终镜像和流式／ICP 端到端验收已通过。Docker Desktop 恢复后，隔离容器再次健康，运行时 TLS 保持默认。备用镜像源候选和旧补丁仅作历史备选，不直接应用覆盖新实现。不推送、不发布。

## 已确认范围

1. 首页仅两张磁贴：ICP 配准、高斯流式数据处理，各自有工作台和历史。
2. ICP 保留双模型输入、业务矩阵、粗配准、ICP、双向矩阵及同一位置的 A／B 坐标查询；新页面移出缓存生成、进度、重试、下载。
3. 流式处理独立单模型任务，支持单文件、带清单的目录／ZIP、显式已有 LOD 文件组（首版 Gaussian PLY／Compressed PLY）。生成前能预览、调整业务矩阵、剖切、单坐标查询；生成后预览并流式下载 ZIP。
4. 复用一套 PlayCanvas 基础引擎、相机、输入与工具管理，不创建假模型 B，不通过创建配准会话运行单模型工具。
5. 业务矩阵为文件→业务，支持现有 TRS／矩阵编辑；保持大坐标双精度还原。所有 LOD 与原始／缓存预览共用矩阵及显示原点。矩阵、剖切不写入生成缓存；切换模型表示不重置相机。
6. 已有 LOD 顺序由用户明确提交，点数和名称只辅助排序，服务生成内部清单。已有层级不再降采样；空间切片不自动猜成 LOD。原始 Gaussian 全属性通道与 ICP XYZ 通道分离。
7. 流式任务服务端独立持久化、可恢复、可重试，使用独立目录和执行槽；缓存下载有校验和占用保护，不受配准清理影响。
8. 沿用固定依赖、单仓库单服务、现有 ICP 数值路径与 v2 兼容接口。源数据只读，不批量搬迁或删除历史目录。

## 目录与协作约定

- `service/streaming_tasks.py`、`service/routes/streaming.py`：独立流式任务领域与路由，测试置于 `tests/service/test_streaming_tasks.py`；后端负责人修改 `service/app.py` 的装配。
- `web/src/engine/core/`、`web/src/engine/modules/`：从现有引擎提取公共能力和单模型控制器。公共类型不依赖 A／B；配准适配器保持现有调用兼容。
- `web/src/views/streaming/`：流式工作台与上传／层级／任务组件，新目录只放流式业务 UI；`web/src/api/streaming-api.ts` 保存类型化 API。
- `web/src/views/ToolkitHomeView.vue`：工具磁贴；原配准首页改走 `/registration`，旧 `/registration/:sessionId` 保留。流式工具使用 `/streaming` 及 `/streaming/:taskId`。
- 新服务数据仅位于 `runtime/streaming-tasks/{UUID}`，任务含 `workspace_id` 与 owner 隔离；原始输入、预览、构建临时数据与输出分别组织。不引入数据库或全局依赖。
- 共享文件 `CLAUDE.md`、`ROADMAP.md`、本清单、`router.ts`、README 由根任务统一维护，协作者汇报断点，避免互相覆盖。

## 任务清单

### A．规范与基线

- [x] A1 从干净 main 创建独立分支，记录基线 SHA。
- [x] A2 更新项目规范、输入契约、实施方案与续作清单，执行差异检查。
- [x] A3 执行现有 Web 类型检查、生产构建、服务回归；记录当前基线及任何既有问题。

### B．独立流式后端

- [x] B1 明确单模型任务契约并与前端对齐；单文件／目录数据集／有序 LOD 文件组上传，workspace／owner 隔离。
- [x] B2 输入探测、Gaussian 属性／重复／路径校验，记录各层元数据与业务矩阵；按轻层生成预览，共用确定性原点。
- [x] B3 独立生成流程：单文件生成 LOD，已有 LOD 直接分层编码，LCC 系列保留 LOD，Streamed SOG 校验复用；禁止借用配准 session。
- [x] B4 持久化状态、重启恢复、失败重试、资源访问、独立历史、业务矩阵更新；保留期与运行／下载占用保护。
- [x] B5 复用流式 ZIP／校验清单并覆盖成功、中断、权限与路径边界测试。

### C．公共引擎与单模型工作台

- [x] C1 抽取共用 Application、相机、输入、工具管理，保持 RegistrationEngine 兼容与行为。
- [x] C2 单模型场景与显示控制，支持原始 Gaussian、中心点、已有 LOD、生成缓存，正确释放资源并保留相机。
- [x] C3 单模型业务矩阵、双精度原点、单组坐标拾取／输入／复制，更新矩阵时同步。
- [x] C4 共用剖切、原点平面、坐标轴、视角与手柄，互斥和相机阻断正确；原点平面固定于模型原点。
- [x] C5 对矩阵、大坐标、资源生命周期及配准适配器运行针对性回归。

### D．产品入口与工作流

- [x] D1 磁贴首页、两工具独立路由、返回首页、各自历史。
- [x] D2 配准上传、页头、历史移出缓存功能，保留 ICP 全流程与旧 API／结果兼容。
- [x] D3 流式输入三种模式、LOD 自然排序／可调整确认、文件元数据与错误提示。
- [x] D4 流式三维页面、业务矩阵、单坐标查询、工具面板、原始／缓存预览。
- [x] D5 独立任务进度／失败重试／刷新恢复／历史／下载进度及错误恢复。

### E．验证与交付

- [x] E1 服务新旧回归、Web 针对性测试、类型检查、生产构建、差异检查。
- [x] E2 小型真实 Gaussian 单文件与已有 LOD 文件组端到端：上传→预览→生成→下载→解包清单检查。
- [x] E3 浏览器验收：首页、两个工具、矩阵／单坐标、剖切、LOD／缓存切换保持相机、刷新恢复，控制台无新错误。
- [x] E4 ICP 合成矩阵和真实数据回归，显示与缓存处理不改变 ICP 输入／结果。
- [x] E5 Windows／Docker 可用性先核实，再运行相关验收；Windows 最新代码已通过。Docker Linux 隔离运行镜像 `stage14-closeout-20260924` 通过健康、接口、单文件／LOD／流式 ZIP 再导入及 305 万点真实模型的上传、预览、生成、下载和清单校验；同容器 ICP A／B 双角色回归通过。完整 Dockerfile 冷构建受 npm registry TLS 连接重置阻塞，单列为环境限制。
- [x] E6 更新 README、API 文档、ROADMAP 与清单，记录最终验证和剩余限制；不自行 push／发布。
- [x] E7 受限网络构建收尾：正式 Dockerfile 默认使用官方 npm 源，安装失败后在下载命令内以 TLS 1.2 有限重试；APT 更新／安装分别有限重试。镜像构建和新镜像真实流式／ICP 验收通过，运行时 Node TLS 保持默认；备用镜像源候选保留。

## 接口与实施决策记录

- 2026-09-22：用户的「单模型业务矩阵」解释为加载设置，不烘焙进输出；视口剖切也不改变输出范围。
- 2026-09-22：维持当前服务按元数据最粗 LOD 准备 ICP 计算数据的行为，仅修正规范冲突，不借本次变更调整算法。
- 流式 API 和单模型引擎公开接口：实施负责人确定后立即补充，前后端按同一契约实现。
- 2026-09-22 第一版流式 API：`POST /api/v2/streaming-tasks` multipart：`input_kind=single|dataset|lod_group`、`workspace_id`、`business_transform` JSON；`file` 供单文件／ZIP，重复 `files` 供目录／顺序即 LOD。`GET /api/v2/streaming-tasks?workspace_id=`、`GET /{task_id}`、`PUT /{task_id}/business-transform`、`POST /{task_id}/generate`、`GET /{task_id}/preview`、`GET /{task_id}/download`。详情包含独立 `status`、`cache_status`、`metadata`、`preview_url`、`gaussian_url`、`cache_url`、`lods` 与加载矩阵；带随机令牌的 `/streaming-resources/{task_id}/{token}/...` 供 PlayCanvas 直接读取。仍须以端到端验证和前端对接收口。

## 验证记录

- 2026-09-28 官方源构建修复收口：首次无缓存构建使用官方源安装 pnpm 10.33.0 和 69 个冻结锁文件依赖并构建 Web；APT 502 后将索引更新与安装分别最多重试三次，最终 Dockerfile 构建镜像 `ply-pcd-registration:stage14-official-safe-20260927` 成功，最终构建复用了前一轮已验证的 Web 下载层。隔离容器运行时 `NODE_OPTIONS` 为空、Node TLS 上限仍为 1.3。单文件、显式 LOD、ZIP 再导入、真实 3,059,456 点均完成上传、预览、业务矩阵、生成及下载，真实 ZIP 68,624,389 bytes、73 个文件 CRC／SHA-256 全通过。ICP 合成 A／B RMS `7.41627e-07`／`5.04159e-07`，真实 PLY／PCD B 移动 RMS `0.457745013019`。日志见 `runtime/stage14-official-safe-complete-20260927.log`、`runtime/stage14-official-safe-streaming-20260927.log`、`runtime/stage14-official-safe-icp-20260927.log`、`runtime/stage14-official-safe-icp-real-20260927.log`。备用镜像源候选保留；9 月 28 日续作发现 Docker Engine 已停止，当前服务可用性需复查。

- 2026-09-27 官方源重试：用户明确官方 npm 源继续使用，备用候选镜像源保留。正式 Dockerfile 无缓存构建成功取得 pnpm 10.33.0 并下载部分依赖，但默认重试耗尽后下载 `@babel/helper-string-parser` 仍发生 TLS `ECONNRESET`，安装退出 1，完整镜像未生成。日志 `runtime/stage14-official-retry-20260927.log`。候选 Dockerfile 与补丁均保留，正式配置未修改，官方源完整构建仍待通过。

- 2026-09-27（阶段 14 构建候选验收完成）：候选 `runtime/stage14-registry-option.Dockerfile` 显式使用 `NPM_REGISTRY=https://registry.npmmirror.com` 完成完整 `--no-cache` 构建，镜像为 `ply-pcd-registration:stage14-registry-option-20260926`。默认仍为官方源，Corepack 与 pnpm 共用参数，版本及锁文件不变。APT 文件下载重试加安装命令最多三次尝试，间隔两秒；确定性复现验证恢复成功及持续失败退出，两个 RUN 段语法检查通过。新镜像在 `127.0.0.1:8894` 完成单文件、显式 LOD、ZIP 再导入、真实 3,059,456 点流式全流程；真实 ZIP 68,624,389 bytes、73 个清单文件 CRC／SHA-256 全通过。ICP 合成 A／B 角色 RMS 为 `7.41627e-07`／`5.04159e-07`，真实 PLY／PCD B 移动 RMS 为 `0.457745013019`。续作时确认容器运行且重启数 0。服务 128／128、Web 流式专项 10／10、类型检查、生产构建、Windows CTest 1／1 已通过。构建与端到端日志分别为 `runtime/stage14-registry-option-final-build-20260926.log`、`runtime/stage14-final-streaming-e2e-20260926.log`、`runtime/stage14-final-icp-synthetic-20260926.log`、`runtime/stage14-final-icp-real-20260926.log`。正式 Dockerfile／README 的候选补丁待用户确认落地；官方 npm 直连恢复未获验证。

- 2026-09-24 构建网络对照与镜像复验：Windows 主机对 npm 官方源及 `registry.npmmirror.com` 的 pnpm 包 HEAD 均返回 200；`node:22-bookworm-slim` 容器无代理环境变量，Node `fetch` 官方源收到 TLS `ECONNRESET`，镜像源返回 200。仅在 `runtime/stage14-mirror-probe.Dockerfile` 的 Web 构建步骤临时指定 `COREPACK_NPM_REGISTRY`／`npm_config_registry`，`docker build --no-cache` 完整成功，锁定 pnpm 10.33.0 未变。新镜像 `ply-pcd-registration:stage14-mirror-probe-20260924` 的隔离容器在 `127.0.0.1:8893` 健康，单文件／双层 LOD／流式 ZIP 再导入、真实 3,059,456 点模型均通过上传、预览、生成、下载；真实 ZIP 68,624,389 bytes，73 个清单文件 CRC／SHA-256 全通过。ICP 双角色 RMS `7.41627e-07`／`5.04159e-07`。项目 Dockerfile、系统代理、DNS 和依赖来源均未修改；原版直连 npm 冷构建仍未通过。

- 2026-09-24 完整冷构建再试：项目原版 Dockerfile 的 `docker build --no-cache --progress plain` 在 `corepack enable && pnpm install --frozen-lockfile --ignore-scripts` 步骤再次因 `registry.npmjs.org:443` TLS `ECONNRESET` 失败；日志在 `runtime/stage14-full-build-final-20260924.log`，完整镜像未产出。已有 `stage14-closeout-20260924` 验收容器健康为 `ok`，重启数 0。未改项目 Dockerfile、系统网络或依赖来源。

- 2026-09-24 Docker 手动恢复后续验：用户手动启动 Docker Desktop，Linux Engine 29.2.0 恢复；本机日志确认此前 Inference manager 访问 `dockerInference` 失败并导致 backend 关闭，未清理 Docker 内部目录。基于锁定的 `stage14-cpu-verify` 镜像覆盖最新 `service/` 和已构建 Web 静态资源，构建 `ply-pcd-registration:stage14-closeout-20260924`；隔离容器 `ply-pcd-stage14-closeout-20260924` 在 `127.0.0.1:8892` 健康、OpenAPI 均通过。单文件、显式 LOD、流式 ZIP 再导入及真实 3,059,456 点 Compressed PLY 均完成上传→预览→生成→ZIP 下载；真实 ZIP 68,624,389 bytes、73 个清单文件 CRC／SHA-256 全通过。转换期间同容器 ICP 合成 A／B 两角色 RMS 分别为 `7.41627e-07`／`5.04159e-07`，容器重启数 0。完整 Dockerfile 冷构建重试时 Ubuntu 软件源已可解析，但 `corepack` 下载 pnpm 或 pnpm 下载包时收到 `registry.npmjs.org` 的 `ECONNRESET`；降低 pnpm 网络并发的临时 Dockerfile 仍在 corepack 阶段失败，未修改项目 Dockerfile 或系统网络配置。

- 2026-09-24 阶段 14 缺陷收口：已有 Streamed SOG 成果在源数据释放前移至独立 `output`，并发下载和预览／资源响应按实际读取数量保护；重启时优先验证已落盘的 `output/lod-meta.json`，资源路由限定解析后的目录边界并允许 LCC 数据 `.bin`。单模型显示原点固定，业务矩阵编辑更新视口及可见点拾取，文件原点平面随模型业务矩阵；Gaussian 失败、迟到及销毁路径释放 Asset。目录选择复用 Chrome／Edge File System Access API 并保留相对路径；下载失败可复用保存句柄，文件名过滤非法字符并加时间戳，生成进度仅显示真实百分比，否则为不确定进度。`pnpm run test:service` 128／128、Web 专项 14／14、`pnpm run typecheck:web`、`pnpm run build:web`、Windows CTest 1／1 和 `git diff --check` 通过。独立本地服务 `127.0.0.1:8891` 上单文件、双层 LOD、流式 ZIP 再导入，以及真实 3,059,456 点 Compressed PLY 均完成上传、预览、生成、下载；真实 ZIP 68,624,389 bytes，73 个清单文件的 CRC／SHA-256 全通过。Playwright CLI 大模型原始 Gaussian、缓存切换和刷新恢复任务通过，控制台 0 error／0 warning。`docker build --no-cache` 因 `archive.ubuntu.com`／`security.ubuntu.com` 无法解析而失败；随后 Docker Engine 停止，按规范启动 Docker Desktop 一次，客户端仍未能完成 `docker info`，未将旧容器结果算作最新代码通过。

- 2026-09-24 Docker Linux 收口：`service/decimate_cpu.mjs` 复用锁定版 SplatTransform 3.4.2 库 API，不传 WebGPU 设备创建器；文件读取与写入保持流式，超预算中间代支持磁盘暂存。基于现有 `stage14-verify` 锁定运行时镜像覆盖当前 `service/` 构建 `stage14-cpu-verify`，无网络安装。容器健康与流式 OpenAPI 通过；4 点样本完成上传→预览→生成→ZIP 下载，19 个清单文件的 CRC／SHA-256 全部通过。真实 3,059,456 点 Compressed PLY 完成同流程，三层降采样及最终 Streamed SOG `ready 100%`；下载 ZIP 68,624,389 bytes、73 个清单文件，CRC／SHA-256 全部通过。服务回归 121／121。完整 Dockerfile 冷构建未执行成功：主机与容器仍无法解析 Ubuntu 软件源。

- 2026-09-23 单模型公共手柄收口：复用配准工作台的 PlayCanvas 平移／旋转 Gizmo 和 `TransformGizmoInput`，长方体中心平移、旋转与六面拖拽共存；切换坐标查询时隐藏手柄，退出后恢复。浏览器在 299,851 点真实预览中拖动中心后 X 值从 -109.3578 更新到 -65.4748，坐标轴范围保持不变；旋转长方体后修改 X 中心为 -60，姿态仍保留，控制台 0 error／0 warning。截图 `output/playwright/stage14-box-translation.png`、`stage14-box-rotated.png`、`stage14-box-rotate-then-edit.png`。Web 类型检查、生产构建、公共输入／Gizmo 仲裁／相机／配准场景测试 4／4 通过。

- 2026-09-23 单模型长方体状态同步：数值更新现在从同一 PlayCanvas 实体读取完整世界变换，若实体已旋转可保留其旋转。Web 类型检查、生产构建、PlayCanvas 旋转盒逆矩阵几何检查及公共输入／相机／配准场景测试 3／3 通过。Playwright CLI 在真实 299,851 点预览中启用长方体并修改中心值，剖切框显示正常，控制台 0 error／0 warning，截图 `output/playwright/stage14-box-rotation-check.png`；当前公共手柄仅有六面拖拽，旋转手柄尚未实现，故浏览器未验证旋转交互。Docker Engine 29.2.0 可用，Ubuntu 软件源 DNS 仍超时。

- 2026-09-23 Docker 续验：Docker Desktop Linux Engine 29.2.0 就绪。已有 `stage14-verify` 镜像容器完成健康、OpenAPI、上传与预览；单文件生成在 SplatTransform 3.4.2 的 `--decimate` 路径报 `libvulkan.so.1` 缺失。Dockerfile 运行层加入 `libvulkan1` 与 `mesa-vulkan-drivers`，但验证镜像在默认与 host 网络构建时均无法解析 `archive.ubuntu.com`、`security.ubuntu.com`，因此运行库安装及生成复测未完成。`git diff --check` 通过。

- 2026-09-23 大模型端到端：浏览器上传真实 `point_cloud_5.compressed.ply`（49,812,429 bytes，3,059,456 点），预览抽样 299,851 点；原始 Gaussian 正常渲染，坐标拾取返回业务坐标，随后成功生成 4 级 Streamed SOG（总层级计数 5,659,993），缓存状态 `ready 100%`，页面可切换流式缓存并出现 ZIP 下载入口。Playwright 控制台 0 error／0 warning，截图 `output/playwright/stage14-large-model.png` 与 `output/playwright/stage14-large-cache.png`。矩阵、大坐标、剖切、Gaussian 资源循环与输入互斥专项 10／10 通过。

- 2026-09-23 最终回归：服务测试 121／121、Windows CTest 1／1、Web 类型检查、生产构建及 `git diff --check` 均通过；构建只保留既有 PlayCanvas Worker 外部化、WebP WASM 与大包提示。再次执行 `docker info` 确认 `dockerDesktopLinuxEngine` pipe 不存在，未执行容器验收。

- 2026-09-23 保留与辅助工具：到期清理只释放 `input／datasets／computed／preview` 并保留 `output`，主动释放与后台清理均跳过运行／下载占用；新增 retain／release 接口和页面操作，专项覆盖到期、占用、保留与主动释放，服务 121／121。单模型视口新增长方体数值剖切、三原点平面及正负侧剖切、模型坐标轴；Playwright 在原始 Gaussian 显示中启用长方体、坐标轴和 XOY 正侧，控制台 0 error，截图 `output/playwright/stage14-streaming-tools.png`。

- 2026-09-23 显示与拆分：Playwright 在真实 4 点 Gaussian 任务中完成中心点→原始 Gaussian→流式缓存切换，展开并启用坐标轴剖切、修改 X 最大值，控制台 0 error；页面另支持已有 LOD 层级选择及业务坐标拾取／输入／复制。配准页确认缓存选项、后台任务和历史缓存操作均已移除。流式下载专项确认 ZIP CRC、SHA-256 清单和 reader 占用释放；服务 119／119、Web 类型检查、生产构建、Windows CTest 1／1、差异检查通过。Docker Desktop Linux Engine pipe 不存在，本轮未执行 Docker 验收。

- 2026-09-22 单模型续作：4 点 Gaussian PLY、3／4 点 LOD 组经真实 Worker／转换器完成预览和生成，两个输出 ZIP 的文件数为 20／14、CRC 无误；Playwright CLI 打开本地 `/streaming`，上传单文件后任务 ready、预览视口存在，生成后缓存 ready，控制台 0 error。点过少，视觉细节、拾取、矩阵和下载浏览器流尚未验收。Web 类型检查与生产构建通过。

- 2026-09-22 续作：独立流式页面已接入路由，提供三种上传与有序 LOD、状态轮询、矩阵保存、生成与下载及历史。`pnpm run typecheck:web`、`pnpm run build:web`、`pnpm run test:service` 118／118、`git diff --check` 通过。单模型三维引擎、真实转换与浏览器验收仍待完成。

- 2026-09-22 基线：`pnpm run typecheck:web` 通过；`pnpm run build:web` 通过，仅出现既有 PlayCanvas worker externalize、WebP WASM 与大包提示；`pnpm run test:service` 114／114 通过；`git diff --check` 无空白错误，只有仓库 LF→CRLF 提示。
- 2026-09-22 初步编码：`pnpm run build:native` 编译通过，单模型 Worker 对仓库内 Gaussian PLY 样本生成预览成功，输出在 `runtime/stage14-single-preview`；`pnpm run test:service` 118／118 通过（新增有序 LOD、重复拒绝、资源令牌边界、缓存重试测试），`pnpm run typecheck:web` 通过。真实转换、浏览器和 Docker 尚未验收。

## 阻塞与下一步

- 阶段 14 构建修复与新镜像真实数据验收已完成。2026-09-28 Docker Desktop 单次启动后，隔离容器 `ply-pcd-stage14-official-safe-20260927` 恢复运行，`127.0.0.1:8895/health` 返回 `ok`，容器重启计数 0；运行时 Node 默认 TLS 上限 1.3、无 `NODE_OPTIONS`。备用镜像源候选仅保留作历史备选，旧补丁不得直接覆盖当前 Dockerfile。不自行推送或发布。
