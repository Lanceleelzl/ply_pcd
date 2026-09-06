# 通用点云双向 Registration Service

本项目用于计算两个 PLY／PCD／LAS／LAZ 点云模型之间的双向坐标转换矩阵。Gaussian Splatting PLY 与无人机 SLAM 地图是首要业务场景，但格式不再决定模型角色或矩阵方向。

通用接口将业务输出方向和 ICP 角色分开：

```text
业务方向：A→B 或 B→A
ICP 角色：移动 A／固定 B，移动 B／固定 A，或自动推荐
固定输出：T_a_to_b 与 T_b_to_a
```

当前已支持：

- Windows x64 一键本地安装和浏览器使用，普通用户不需要 Visual Studio 或 Python。
- Visual Studio 2022 原生算法开发和自动 Worker 替换。
- C++ 无界面点云配准 Worker。
- 网页上传 PLY／PCD 并查看结果。
- Java、Python 等模块通过 HTTP API 调用。
- Docker Desktop 本地测试。
- Linux Docker 服务器部署。

HTTP API 与网页上传的最小可用版本已经完成。完整设计见 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) 。真实进度见 [ROADMAP.md](ROADMAP.md) 。

正式接口说明见 [docs/API.md](docs/API.md) 。

本地运行和原生 Worker 管理见 [docs/LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md) 。

## Windows 本地一键运行

通用工作台完成 ICP 后，点击「坐标查询」可在模型 A 或 B 上拾取预览点，或直接输入原始 XYZ；另一模型的坐标按最终双向矩阵实时计算。红色点对应 A，蓝色线框球对应 B，可用平移手柄调整。通过「配准位置／原始位置」切换查看同一坐标对，面板坐标不随显示变化。点击「返回配准编辑」恢复配准姿态；重新粗调或切换移动角色后，需要重新 ICP 才能查询。

工具栏的「A 原点／轴」「B 原点／轴」分别显示文件原始零点与 XYZ 方向。LAS／LAZ 显示使用局部偏移，坐标面板还原文件坐标；取点来自轻量中心点预览，不保证命中 Gaussian 椭球视觉表面。第一版查询点仅保存在当前页面，可复制坐标对及 ICP 任务 ID 留存。

```powershell
pnpm install
pnpm run dev
```

开发模式浏览器打开 `http://localhost:5173`；API 服务运行在 `http://localhost:8765`，OpenAPI 文档可从 `http://localhost:5173/docs` 打开。模型 A、模型 B 均可选择 `.ply`、`.pcd`、`.las` 或 `.laz`；上传后页面会由 C++ Worker 解码并生成轻量预览，浏览器无需直接解析 LAZ。

如需修改端口或 v2 会话源文件保留时间，编辑 `config/local.json` 中的 `port`（API）、`web_port`（开发页面）和 `source_retention_hours` 后重新启动服务，无需设置系统或终端环境变量。

工作台左侧按“数据→可选粗配准→ICP→结果”展示完整流程，粗配准工具浮动在三维视口内。PLY 固定，只有 PCD 可以平移和旋转，禁止缩放；不做人工调整时可直接执行 ICP。粗配准默认使用轻量中心点，Gaussian 视觉确认按需流式加载原始 PLY，切回中心点时释放 GPU 资源。人工矩阵作为 `T_manual_pcd_to_ply` 提交，最终组合为 `T_pcd_to_ply = T_icp_delta × T_manual_pcd_to_ply`，业务最终使用页面显式标记的 `PLY→PCD` 矩阵。

`pnpm install` 自动管理项目内 Python 3.12、锁定的 Python 包和预编译 C++ Worker。没有 Visual Studio 2022 时直接使用仓库提供的 Worker；有 Visual Studio 2022 时可执行 `pnpm run build:native` 编译并自动替换它。

网页会将 `T_ply_to_reference` 明确标记为最终业务矩阵。对于 LAS／LAZ，该矩阵已经恢复 LAS 世界坐标原点，可直接用于航点坐标转换；`reference_local_to_ply` 只用于浏览器局部预览，不得作为业务矩阵。

LAS／LAZ 坐标先由 LASzip 以双精度应用 scale／offset，再减去双精度包围盒中心原点后进入 ICP。最终使用 `T_ply_to_reference = Translate(reference_origin) × inverse(T_reference_local_to_ply)` 在双精度中恢复世界坐标，避免大坐标直接转单精度造成精度损失。项目不执行 CRS 重投影，PLY 与定位点云必须表达同一物理空间和长度单位。

工作台默认选择推荐模式：`min_rms_decrease=0.00001`、`sampling_limit=50000`、`overlap=1.0`、`random_seed=42`。其中 `50000` 是 CloudCompare 的默认采样上限，并非用户手工设置；本项目使用固定种子形成可复现基线。高采样稳定性模式先执行该默认参数基线，再以 `500000` 点上限运行三个连续固定种子，输出平移和旋转重复性。更多采样可降低随机子集造成的统计波动，但重复性和 RMS 都不能单独证明绝对坐标精度，生产使用仍需控制点或实飞验证。自定义模式允许在受控范围内修改单阶段参数。ICP 始终读取原始 PLY／PCD，浏览器预览数据不参与计算。

人工配准会话支持多轮迭代。每轮完成后会恢复 PCD 平移／旋转、模式切换和参数编辑；下一轮始终以视口中当前 PCD 的绝对 `PCD→PLY` 矩阵为初值，并重新读取会话保存的原始 PLY／PCD。页面保留每轮参数、初始矩阵、最终矩阵和指标；在结果后再次移动 PCD 或修改参数时，上一次矩阵会被明确标记为已过期，直至下一轮 ICP 完成。

“在三维场景中显示配准过程”默认关闭，但在 ICP 运行期间始终可操作。中途勾选时，页面通过 SSE 直接读取当前最新一轮并继续更新移动模型；取消勾选只停止视口动画，不会终止 ICP，再次勾选会接回当前进度。实时姿态只用于观察收敛过程；成功时由最终结果矩阵覆盖，终止时停留的未收敛姿态不得用于航点转换。

逐轮迭代、RMS、点数和耗时显示在三维视口工具栏下方。当前移动／固定模型及黄色／灰色说明显示在左侧第 1 步“模型”区域。若移动模型的包围盒对角线达到固定模型的 `1.25` 倍，页面会提示“大范围移动匹配小范围”的错误收敛风险，并建议交换 ICP 移动／固定角色；业务矩阵方向无需随之改变，直接读取服务返回的目标方向矩阵即可。

三维视口左上角第一排粗配准工具栏末尾提供“A：显示”和“B：显示”开关，可独立隐藏或恢复两个模型。显示状态只影响浏览器视口，不影响粗配准矩阵、ICP 输入或最终结果；隐藏当前移动模型时，其变换手柄也会同步隐藏。显示开关在 ICP 运行期间仍可操作。

v1 单次任务完成或失败后立即删除上传副本。v2 通用会话的原始模型和预览默认保留 24 小时，以便继续粗配准或重新执行 ICP；首页历史区可延长 24 小时或立即释放。释放后只保留轻量结果档案，包括双向矩阵、模型摘要与 SHA-256、ICP 参数、RMS、版本和时间。服务每 3600 秒执行一次到期清理。可在 `docker/docker-compose.yml` 中调整：

```text
REGISTRATION_RESULT_RETENTION_HOURS
REGISTRATION_CLEANUP_INTERVAL_SECONDS
REGISTRATION_SOURCE_RETENTION_HOURS
```

清理范围仅限服务管理的 `runtime/jobs/{job_id}` 和 `runtime/manual-sessions/{session_id}`，不会处理只读的 `source` 原始数据。历史档案保存在 `runtime/history/{workspace_id}`，源文件释放后矩阵仍可查看和复制。

推荐使用通用 `v2` 会话接口；现有 `v1` PLY→定位参考点云接口继续兼容：

```text
POST /api/v2/registration-sessions
GET  /api/v2/registration-sessions/{session_id}
POST /api/v2/registration-sessions/{session_id}/register
GET  /api/v2/registration-history?workspace_id={workspace_id}
POST /api/v2/registration-sessions/{session_id}/retain
POST /api/v2/registration-sessions/{session_id}/release
POST /api/v2/registration-sessions/{session_id}/resume
POST /api/v1/registrations
GET  /api/v1/registrations/{job_id}
GET  /api/v1/registrations/{job_id}/result
GET  /api/v1/registrations/{job_id}/events
GET  /api/v1/registrations/{job_id}/files/{filename}
GET  /health
```

Python 示例见 `examples/python_client.py`，需要安装 `requests`。Java 11＋无第三方依赖示例见 `examples/RegistrationClient.java`。

## Docker 部署与验证

Docker Desktop 使用 WSL2 Linux 后端。`ubuntu:24.04` 是容器基础镜像，不会安装或替换本机 WSL 发行版。

使用 pnpm 构建并启动镜像：

```powershell
pnpm run docker:build
pnpm run docker:up
```

Docker 与本地服务默认都使用 `8765` 端口，切换前先停止另一种运行方式。

检查默认 PCD：

```powershell
docker compose -f docker\docker-compose.yml run --rm registration-worker
```

使用 `source/ply/point_cloud.ply` 和 `source/pcd/GlobalMap.pcd` 执行真实配准：

```powershell
docker compose -f docker\docker-compose.yml run --rm registration-worker register `
  --ply /data/source/ply/point_cloud.ply `
  --pcd /data/source/pcd/GlobalMap.pcd `
  --output-dir /data/runtime/jobs/docker-real `
  --random-seed 42
```

结果写入 `runtime/jobs/docker-real/`。其中 `ply_to_pcd_matrix.txt` 是业务需要的 PLY→PCD 矩阵，`registration.json` 包含双向矩阵、RMS、点数、参数和耗时。
