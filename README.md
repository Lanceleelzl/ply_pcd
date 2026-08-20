# PLY／PCD Registration Service

本项目用于计算室内 Gaussian Splatting PLY 模型与无人机 SLAM PCD 地图之间的坐标转换矩阵。

核心处理方向：

```text
PCD 配准到 PLY
      ↓
获得 T_pcd_to_ply
      ↓
求逆获得 T_ply_to_pcd
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

```powershell
pnpm install
pnpm run dev
```

浏览器打开 `http://localhost:8080`，选择一个 `.ply` 和一个 `.pcd` 文件即可创建异步配准任务。OpenAPI 文档位于 `http://localhost:8080/docs`。

`pnpm install` 自动管理项目内 Python 3.12、锁定的 Python 包和预编译 C++ Worker。没有 Visual Studio 2022 时直接使用仓库提供的 Worker；有 Visual Studio 2022 时可执行 `pnpm run build:native` 编译并自动替换它。

网页会将 `T_ply_to_pcd` 明确标记为「最终业务矩阵：PLY → PCD」。程序计算使用高精度 `ply_to_pcd`；CloudCompare 手工验证使用 `ply_to_pcd_cloudcompare`。

上传页默认选择推荐模式：`min_rms_decrease=0.00001`、`sampling_limit=50000`、`overlap=1.0`、`random_seed=42`。扩大采样实验模式使用 `150000／0.95`，但实测精度不如默认组合；高级设置允许在受控范围内修改全部四个参数。

任务完成或失败后，服务立即删除上传的 PLY／PCD 输入副本。矩阵、JSON 和日志默认保留 168 小时，并每 3600 秒执行一次过期清理。可在 `docker/docker-compose.yml` 中调整：

```text
REGISTRATION_RESULT_RETENTION_HOURS
REGISTRATION_CLEANUP_INTERVAL_SECONDS
```

清理范围仅限 `runtime/jobs/{job_id}`，不会处理只读的 `source` 原始数据。

主要接口：

```text
POST /api/v1/registrations
GET  /api/v1/registrations/{job_id}
GET  /api/v1/registrations/{job_id}/result
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

Docker 与本地服务默认都使用 `8080` 端口，切换前先停止另一种运行方式。

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
