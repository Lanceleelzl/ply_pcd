# Roadmap

## 当前阶段

```text
阶段 6：HTTP 服务与网页 MVP
状态：已完成，待进入生产化阶段
```

## 已完成

- 已分析 Gaussian PLY 文件头、属性、点数和坐标范围。
- 已分析 GlobalMap PCD、局部扫描、位姿和地图元数据。
- 已确认 CloudCompare 手工成功流程为“PCD 作为 data、PLY 作为 model”。
- 已确认最终业务矩阵为 `T_ply_to_pcd = inverse(T_pcd_to_ply)`。
- 已核对本地 CloudCompare ICP 调用链、参数和混合精度。
- 已完成拟使用模块的初步许可证审计。
- 已确定 Windows VS2022＋Docker Desktop＋Linux Docker 的开发部署路线。
- 已固化完整实施方案文档。
- 已保存用户提供的 CloudCompare 成功 `PCD→PLY` 矩阵和计算得到的逆矩阵，作为首个真实数据黄金基线。
- 已初始化 Git `main` 分支。
- 已建立 CMake 与 Visual Studio 2022 Debug／Release Presets。
- 已实现无界面 Gaussian PLY `x/y/z` 解析器。
- 已实现 PCD v0.7 ASCII／binary `x/y/z` 解析器。
- 已实现 `4×4` 矩阵读取、通用求逆、乘法和方向回归测试。
- 已通过真实数据解析测试：PLY `3,777,901` 点，PCD `149,317` 点，均无非法坐标。
- 已通过 VS2022 Debug 构建和 CTest。
- 已从固定 CloudCompare commit 提取项目内 CCCoreLib 源码，不依赖外部 CloudCompare 安装。
- 已关闭 Qt Concurrent、TBB、CGAL 和动态库构建，Windows 静态编译成功。
- 已实现固定方向的 CloudCompare ICP 适配层：PCD 为 data、PLY 为 model。
- 已为 CloudCompare 随机采样增加可配置固定种子，种子 `42` 重复运行矩阵逐元素一致。
- 已实现 `registration_worker register`，可输出两个方向矩阵和 JSON 指标。
- 已完成真实数据配准：固定种子结果 RMS `0.222231`，最终点数 `50,000`。
- 固定种子结果与手工黄金矩阵相比，平移差约 `1.55 cm`、旋转差约 `0.17°`，处于实测随机采样波动范围内。
- 已加入真实数据 ICP 回归和确定性测试，VS2022 Release CTest `1／1` 通过，耗时约 `44.3 s`。
- 已补项目许可证正文、NOTICE、第三方声明和源码审计文档。
- 已完成 CLI 参数、错误码、运行日志、双向矩阵文件和完整 JSON 输出。
- 已完成 Ubuntu 24.04 多阶段 Docker 镜像和 Docker Compose 本地挂载配置。
- 已确认 Docker Desktop 使用 WSL2 Linux 后端，容器内 PCD 解析结果与 Windows 一致。
- 已完成容器内真实数据 ICP：Linux 与 Windows 固定种子矩阵逐元素最大差值为 `0`，RMS 均为 `0.222230612453`。
- 已在 README 补充 Docker Desktop 构建、检查、真实配准和结果目录说明。
- 已修复 GCC 识别出的 PLY／PCD 字段名临时对象引用告警，并重新通过 Windows CTest 和 Linux 编译。
- 已实现 FastAPI 流式上传、异步任务状态、结果 JSON 和结果文件下载接口。
- 已实现 C++ Worker 独立子进程调用、并发限制、超时处理和失败隔离。
- 已提供浏览器上传与矩阵结果页面，以及 Python 和 Java 11＋调用示例。
- 已完成 API 失败隔离验证：无效 PLY 返回 Worker 错误，API 进程继续健康运行。
- 已完成真实文件 API 端到端验证：上传约 257 MB PLY 和 4.8 MB PCD 后成功配准，结果矩阵与容器 CLI 基线逐元素一致。
- 已将网页和 API 的 `T_ply_to_pcd` 标记为推荐的最终业务矩阵，其余矩阵作为辅助结果展示。
- 已实现任务完成后立即清理上传文件、默认保留结果 7 天并按小时清理过期任务；清理范围仅限 `runtime/jobs/{UUID}`。
- 已提供标准 API 文档，覆盖接口、模型、错误码、状态机、矩阵约定、保留策略以及前端／Java／Python 调用方式。
- 已在上传页增加高精度／快速模式、高级参数、恢复推荐值和参数风险提示；高精度默认值为 `1e-5／150000／0.95／42`。
- 已统一页面、HTTP API 和 API 文档的默认值与参数范围，并在结果页显示实际参数、米／厘米 RMS 及误差含义警告。
- 根据 CloudCompare 手工复核结果，将“推荐模式”默认参数恢复为实测更准确的 `1e-5／50000／1.0／42`；`150000／0.95` 降级为扩大采样实验模式。

## 进行中

- 补充自动化 API 回归测试脚本。
- 评估生产环境鉴权、外部对象存储和持久化任务队列。

## 待办

### 阶段 1：项目骨架与许可证基线

- 初始化 Git。
- 创建 CMake 工程和 Visual Studio 2022 Presets。
- 创建许可证、NOTICE、第三方声明和逐文件审计表。
- 建立 Windows 与 Linux 的最小编译测试。

### 阶段 2：文件解析

- 已采用无界面流式解析实现 Gaussian PLY Reader。
- 已实现 PCD Header、ASCII 和 binary 解析。
- 已完成当前真实文件解析测试。
- 待补解析器异常格式和截断文件测试。

### 阶段 3：ICP 核心

- 已提取 CCCoreLib 源码并建立固定上游基线。
- 已封装固定方向的 PCD→PLY ICP。
- 已输出 PCD→PLY 与 PLY→PCD 矩阵。
- 已建立 CloudCompare 黄金矩阵真实数据回归测试。
- 待增加小型合成点云 ICP 测试。

### 阶段 4：C++ CLI

- 实现参数解析、配置、日志和错误码。
- 实现任务目录和标准 JSON 输出。
- 完成 Windows Release 构建与真实数据验证。

### 阶段 5：Docker Linux

- 已编写 Ubuntu 24.04 多阶段 Dockerfile。
- 已完成容器内编译、文件解析和真实数据回归。
- 已验证 Windows 与 Linux 固定种子矩阵逐元素一致。

### 阶段 6：HTTP 服务与网页

- 已实现流式上传和异步任务接口。
- 已实现 C++ Worker 子进程隔离、并发限制和超时控制。
- 已实现任务状态、矩阵显示、下载和错误信息页面。
- 已提供 Java、Python 调用示例。

### 阶段 7：自动粗配准与生产化

- 评估和接入 4PCS 自动粗配准。
- 增加多 overlap 候选与结果评分。
- 增加 MinIO／S3、任务队列、保留策略和负载测试。

## 阻塞

- 当前黄金矩阵只有 6 位小数，且未知 CloudCompare 随机采样种子；可以用于几何回归，但不能作为逐位一致基线。若能导出更高精度矩阵，应替换当前基线。
- 尚未确认最终公开仓库地址和真实测试数据是否随项目公开。

## 最近验证

```text
日期：2026-08-20
方式：Docker Desktop／WSL2 FastAPI 服务＋Worker 子进程＋真实 PLY／PCD multipart 上传
结果：健康页、上传页和 OpenAPI 均返回 200；OpenAPI 默认值已核对为 sampling_limit=50000、overlap=1.0、min_rms_decrease=1e-5、random_seed=42；页面默认显示“推荐模式”，并将 150000／0.95 标记为实验模式；此前默认组合真实任务 RMS 0.222230612453，API 与容器 CLI 矩阵逐元素最大差值为 0
```
