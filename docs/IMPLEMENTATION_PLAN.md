# Gaussian PLY／定位参考点云坐标配准服务实施方案

## 1．目标与边界

### 1.1 输入

- 室内扫描设备生成的 Gaussian Splatting PLY。
- 无人机机载雷达 SLAM 生成的 PCD 全局定位地图。
- LAS／LAZ 格式的定位参考点云；其角色、移动方向和业务输出与 PCD 相同。
- 可选初始矩阵。
- 可选 ICP 参数。

### 1.2 输出

- `T_pcd_to_ply`：PCD 坐标转换到 PLY 坐标。
- `T_ply_to_pcd`：PLY 坐标转换到 PCD 坐标，作为主要业务结果。
- 最终 RMS、有效对应点数、迭代次数、重叠参数和运行耗时。
- CloudCompare 兼容 `float32` 矩阵。
- 高精度 `float64` 矩阵。
- 配准日志和可选预览点云。

### 1.3 固定方向

```text
data：PCD，移动
model：PLY，固定
```

CloudCompare 手工验证已证明，小范围 PCD 配准到大范围 PLY 可以达到预期；反向配准会受到 PLY 大量非重叠区域干扰。

数学约定：

```text
p_ply = T_pcd_to_ply * p_pcd
p_pcd = T_ply_to_pcd * p_ply
T_ply_to_pcd = inverse(T_pcd_to_ply)
```

统一采用齐次列向量。

## 2．已知数据

### 2.1 Gaussian PLY

```text
路径：source/ply/point_cloud.ply
格式：binary_little_endian
vertex：3,777,901
属性数：17
```

主要字段：

```text
x y z
nx ny nz
f_dc_0 f_dc_1 f_dc_2
opacity
scale_0 scale_1 scale_2
rot_0 rot_1 rot_2 rot_3
```

第一版 ICP 只使用 Gaussian 中心 `x/y/z`，与 CloudCompare 手工流程一致。

### 2.2 PCD

```text
路径：source/pcd/GlobalMap.pcd
格式：PCD v0.7，DATA binary
点数：149,317
```

字段：

```text
x y z intensity normal_x normal_y normal_z curvature
```

第一版只读取 `x/y/z`。

## 3．源码提取策略

### 3.1 原则

- 从本地 CloudCompare 固定 commit 提取实际需要的最小源码闭包。
- 源文件复制到本项目后再裁剪，不修改上游工作区。
- 不链接 CloudCompare 已编译库。
- 不启动 CloudCompare GUI 或 CLI。
- 删除 GUI、Qt Widgets、OpenGL、插件、材质、纹理和 Mesh 等无关功能。
- 无法合理裁剪且逻辑简单的部分由本项目独立实现。
- 保留上游版权、许可证和修改记录。

### 3.2 上游基线

```text
E:\Geosv_space\CloudCompare
v2.13.1-430-gda62b8e0
da62b8e0155cee4237335476477cb1088c54c2f3
```

### 3.3 预期提取模块

ICP 及其依赖候选：

```text
RegistrationTools
PointProjectionTools
CloudSamplingTools
DistanceComputationTools
DgmOctree
DgmOctreeReferenceCloud
PointCloud
PointCloudTpl
ReferenceCloud
GenericCloud
GenericIndexedCloud
GenericIndexedCloudPersist
ScalarField
SquareMatrix
Jacobi
NormalDistribution
ParallelSort
Garbage
```

实际编码阶段通过编译和调用图确定最小闭包。没有进入最终调用路径的源文件不复制。

### 3.4 文件解析

PLY：

- 提取 MIT 许可的 `rply`。
- 参考 `PlyFilter` 的属性识别，封装无界面 `GaussianPlyReader`。
- 只分配 `x/y/z`。
- 其他 Gaussian 属性跳过。

PCD：

- 参考 `PcdFilter` 的 Header、字段索引、类型转换和 binary 读取行为。
- 删除 PCL、Boost、Qt、传感器和导出逻辑。
- 第一版支持 `DATA ascii` 与 `DATA binary`。
- `binary_compressed` 后续按需求补充。

## 4．许可证策略

项目整体采用：

```text
GPL-3.0-or-later
```

逐文件规则：

```text
CCCoreLib 派生文件：保留 LGPL-2.0-or-later
PlyFilter／PcdFilter 派生文件：保留 GPL-2.0-or-later
rply：保留 MIT
nanoflann：若使用，保留 BSD
本项目新代码：GPL-3.0-or-later
```

项目必须包含：

```text
LICENSE
COPYING
NOTICE
THIRD_PARTY_NOTICES.md
LICENSES/
docs/license-audit.md
```

每个提取文件记录：

- 本项目路径。
- 上游路径。
- 上游 commit。
- 原许可证。
- 修改摘要。
- 依赖文件。
- 对应测试。

## 5．精度兼容

本地 CloudCompare 已确认：

```cpp
using PointCoordinateType = float;
using ScalarType = double;
```

变换内部使用：

```text
R：double
T：double
s：double
RMS：double
```

GUI 最终矩阵转换为 `float32`。

本项目采用：

```text
输入和内部点坐标：float32
最近邻距离和距离累计：float64
质心、协方差、刚体求解：float64
累计矩阵：float64
RMS：float64
业务矩阵：float64
CloudCompare 兼容矩阵：float32
```

服务不得只输出截断后的 GUI 矩阵。高精度矩阵用于业务计算，兼容矩阵用于对照 CloudCompare。

## 6．ICP 行为

### 6.1 默认参数

```text
convType：MAX_ERROR_CONVERGENCE
minRMSDecrease：1e-5
adjustScale：false
finalOverlapRatio：1.0
normalsMatching：NO_NORMAL
samplingLimit：50000
filterOutFarthestPoints：false
maxThreadCount：0
```

### 6.2 执行过程

```text
加载 PLY、PCD
  ↓
过滤 NaN／Inf
  ↓
PCD 和 PLY 随机采样到限制规模
  ↓
计算 PCD 到 PLY 最近邻对应
  ↓
按 overlap 保留对应
  ↓
求当前刚体增量
  ↓
累计矩阵
  ↓
重新计算对应和 RMS
  ↓
RMS 恶化则拒绝当前步
  ↓
delta RMS < 1e-5 时停止
```

必须复现：

- 数据／参考角色。
- 采样上限语义。
- overlap 截断语义。
- RMS 计算精度。
- 恶化步骤处理。
- 收敛停止位置。
- 矩阵累计顺序。

### 6.3 随机性

CloudCompare 的采样可能导致重复运行有自然波动。本项目需要：

- 支持固定随机种子。
- 默认使用确定性种子，保证服务可回归。
- 结果中记录随机种子和采样点数。
- 另设 CloudCompare 兼容模式，用于对照其采样行为。

## 7．软件结构

```text
E:\Geosv_space\ply_pcd
├── cpp/
│   ├── include/registration/
│   ├── src/
│   └── tests/
├── libs/
│   ├── registration_core/
│   └── rply/
├── service/
├── web/
├── docker/
├── config/
├── docs/
├── source/
├── runtime/
└── tests/
```

### 7.1 C++ 模块

```text
GaussianPlyReader
PcdReader
PointCloudValidator
CloudSampler
CloudCompareIcpAdapter
MatrixConverter
RegistrationValidator
RegistrationPipeline
registration_worker
```

公开类型必须明确矩阵方向：

```cpp
struct RegistrationResult
{
    Matrix4d pcdToPly;
    Matrix4d plyToPcd;
    Matrix4f pcdToPlyCloudCompare;
    Matrix4f plyToPcdCloudCompare;
    double finalRms;
    uint64_t finalPointCount;
    uint32_t iterationCount;
};
```

## 8．Windows 开发

### 8.1 工具

```text
Visual Studio 2022
MSVC v143
Windows 10／11 SDK
CMake
Ninja，可选
Docker Desktop＋WSL2
```

### 8.2 Presets

计划提供：

```text
windows-debug
windows-release
linux-docker-release
```

本地构建产物：

```text
registration_worker.exe
registration_tests.exe
```

Windows 用于断点调试和 CloudCompare 桌面对照，不作为 Linux 服务器交付物。

## 9．文件提交方式

### 9.1 开发目录模式

当前数据不需要复制：

```text
source/ply/point_cloud.ply
source/pcd/GlobalMap.pcd
```

Worker 直接接收路径。Docker 将 `source` 只读挂载到 `/data/source`。

### 9.2 网页上传

用户访问：

```text
http://localhost:8765
```

选择 PLY 和 PCD 后创建异步任务。上传必须流式写入：

```text
runtime/jobs/{job_id}/input
```

完成后网页显示矩阵、RMS、点数和下载链接。

### 9.3 Java／Python API

小规模环境支持 multipart 上传。生产大文件优先通过 MinIO／S3 URI 提交，避免 Java 服务重复中转大文件。

## 10．CLI

```text
registration_worker
  --ply <path>
  --pcd <path>
  --mode icp|auto
  --initial-matrix <path，可选>
  --overlap 1.0
  --rms-difference 1e-5
  --sampling-limit 50000
  --output-dir <path>
```

输出目录：

```text
pcd_to_ply_matrix.txt
ply_to_pcd_matrix.txt
registration.json
registration.log
registered_pcd.ply，可选
overlay_preview.ply，可选
```

退出码必须区分参数、解析、点数不足、ICP、矩阵、内存和超时错误。

## 11．HTTP 服务

### 11.1 架构

```text
Java／Python／网页
        ↓ HTTP
FastAPI Registration API
        ↓ 独立子进程
C++ registration_worker
```

C++ Worker 必须与 API 进程隔离。

### 11.2 主要接口

```text
POST /api/v1/registrations
POST /api/v1/registrations/from-storage
GET  /api/v1/registrations/{job_id}
GET  /api/v1/registrations/{job_id}/matrix
GET  /health
GET  /ready
```

任务为异步执行，POST 不等待 ICP 完成。

## 12．Docker

### 12.1 构建阶段

- Ubuntu 24.04。
- 安装 GCC、CMake、Ninja 和必要构建依赖。
- 编译 C++ Worker。
- 执行 C++ 单元测试。
- 安装到 `/opt/registration`。

### 12.2 运行阶段

- 使用精简 Python 基础镜像。
- 只复制 Worker、服务代码、运行库和许可证。
- 使用非 root 用户。
- 不包含 CloudCompare、Qt GUI、编译器和源码构建环境。

### 12.3 Windows Docker Desktop

```text
source  → /data/source:ro
runtime → /data/runtime
```

本机和服务器使用同一 Linux 镜像。

## 13．测试策略

### 13.1 解析测试

- PLY ASCII／binary little endian。
- 属性顺序变化。
- float32／float64。
- 缺失坐标字段。
- 文件截断。
- NaN／Inf。
- PCD ASCII／binary。
- PCD 字段顺序和类型变化。

### 13.2 矩阵测试

- 刚体矩阵求逆。
- 组合顺序。
- 列向量约定。
- float64／float32 转换。
- PCD→PLY→PCD 往返。

### 13.3 合成 ICP

从参考点云裁剪局部子集，施加已知旋转和平移，增加噪声和离群点，检查恢复误差。

### 13.4 CloudCompare 黄金回归

已保存：

```text
tests/regression/cloudcompare_pcd_to_ply_matrix.txt
tests/regression/cloudcompare_ply_to_pcd_matrix.txt
tests/regression/cloudcompare_icp_parameters.json
```

当前黄金矩阵由用户从成功的 CloudCompare 配准中提供，方向为 `PCD→PLY`。矩阵只有 6 位小数，逆矩阵根据该舍入值计算，因此用于几何结果回归，不作为内部双精度矩阵逐位一致的证明。

比较：

- 平移差。
- 旋转角度差。
- 最终 RMS。
- 有效点数。
- 10 cm／20 cm 内点率。
- CloudCompare 可视化重叠。

不能只比较矩阵文本是否完全相同，因为随机采样可能产生自然波动。应先测量 CloudCompare 自身重复运行波动，再确定最终阈值。

### 13.5 服务与 Docker

- 流式大文件上传。
- Worker 崩溃隔离。
- 超时。
- 并发限制。
- Windows 与 Docker Linux 结果一致。
- Docker 内真实数据回归。

## 14．实施阶段

### 阶段 1：项目骨架

- Git、许可证、CMake、Presets、测试框架。

### 阶段 2：文件解析

- PLY、PCD Reader 和真实文件验证。

### 阶段 3：ICP 核心

- 最小源码闭包、裁剪、固定方向封装和矩阵输出。

### 阶段 4：CLI

- 参数、配置、日志、错误码、任务目录。

### 阶段 5：Docker

- Linux 构建和真实回归。

### 阶段 6：HTTP 与网页

- 上传、任务、结果页面、Java／Python 示例。

### 阶段 7：生产化

- 4PCS、对象存储、队列、并发和负载测试。

## 15．第一阶段验收标准

编码后的第一个可交付版本必须：

1. 在 Windows 读取当前 PLY 和 PCD。
2. 使用 PCD 作为 data、PLY 作为 model。
3. 复现 CloudCompare 当前参数。
4. 输出两个方向的矩阵。
5. 在 CloudCompare 中应用后视觉对齐正确。
6. 通过矩阵合法性和往返测试。
7. 在 Docker Linux 中得到等价结果。
8. 配准失败时返回明确失败，不输出假成功。

## 16．编码开始前待确认

- 用户确认本方案内容。
- 确认是否在阶段 1 初始化 Git。
- 确认真实 PLY／PCD 是否仅本地测试，不随公开仓库发布。

## 17．原始 Gaussian 视觉确认与高精度 ICP

### 17.1 显示职责

- 人工粗配准默认只加载空间均匀采样后的中心点，保证浏览器交互性能。
- Gaussian 视觉确认按需流式加载会话中保存的原始 PLY，不再生成或展示抽样 Gaussian PLY。
- 原始 Gaussian 只用于视觉确认，不参与浏览器拾取，也不替代原始文件上的 ICP。
- 前端在下载前显示原始文件大小，并允许切回中心点后释放 Gaussian GPU 资源。

### 17.2 ICP 精度模式

- `recommended`：采用 CloudCompare 默认的 `50000` 点采样上限，并增加固定种子形成项目内可复现基线；该数值并非用户手工设置。
- `high_accuracy`：先以 `50000` 点完成稳定收敛，再以第一阶段结果为初值执行多个固定种子的高采样精配准。提高采样量用于降低随机子集造成的统计波动，多个种子用于衡量重复性，不直接代表绝对精度提高。
- 高精度第二阶段默认采样上限为 `500000`；当前 PCD 小于该上限，因此使用完整 PCD，PLY 使用空间规模更大的采样集合。
- 高精度模式至少运行三个连续固定种子，输出各候选矩阵、平移稳定性、旋转稳定性和是否达到稳定阈值。
- 不承诺仅凭 ICP RMS 保证航点安全；生产验收仍必须使用独立控制点或实飞测量验证转换误差。

### 17.3 结果选择与阈值

- 高精度最终矩阵使用第二阶段基准种子的结果，其他种子只用于稳定性评估，不以最低 RMS 偷换结果。
- 平移稳定性使用候选平移向量相对基准矩阵的均方根偏差。
- 旋转稳定性使用候选相对旋转的角度均方根偏差。
- 初始建议阈值为平移 `0.02 m`、旋转 `0.2°`，结果中必须同时返回实际值与阈值。

### 17.4 多轮人工配准状态机

- 人工会话状态保持 `ready`，仅当前轮任务使用 `queued／running／succeeded／failed`；运行期间前端暂时锁定 PCD 和参数，结束后立即恢复。
- 每轮提交视口当前绝对 `T_initial_pcd_to_ply`，Worker 始终读取会话中的原始 PLY／PCD，禁止在上一轮已变换点坐标上再次累积变换。
- 会话状态保存各轮任务 ID、实际参数、初始矩阵、结果地址和状态；同一会话同一时间只允许一个活动任务。
- 每轮成功后将 `T_final_pcd_to_ply` 应用到视口，并保存对应的 `T_final_ply_to_pcd` 业务矩阵。
- 成功后再次修改 PCD 姿态或参数时，当前结果标记为已过期；历史矩阵仍可查看、复制或恢复到视口，但未经新一轮 ICP 不得作为当前姿态的有效结果。

## 18．LAS／LAZ 定位参考点云

### 18.1 解析与依赖

- 固定引入 LASzip 官方 `3.5.0` 源码，commit 为 `fa089bd8b2b4ca5631e199d257374c32a125f73f`，随 CMake 静态编译。
- 支持 LAS 1.0—1.4 与 LASzip 可解码的点格式 0—10；首期只读取 XYZ，不进行 CRS 重投影。
- 浏览器不解析原始 LAS／LAZ。C++ Worker 解析后生成与 PCD 相同的轻量预览协议，PlayCanvas 只负责显示。

### 18.2 大坐标精度

LASzip 先以 `float64` 应用 LAS 文件头 scale／offset，得到世界坐标。选择文件头包围盒中心作为确定性 `reference_origin`，点坐标按以下顺序进入 ICP：

```text
p_reference_local_f32 = float32(p_reference_world_f64 - reference_origin_f64)
```

ICP 求得局部矩阵后，在双精度中组合世界原点：

```text
T_reference_world_to_ply = T_reference_local_to_ply × Translate(-reference_origin)
T_ply_to_reference_world = Translate(reference_origin) × inverse(T_reference_local_to_ply)
```

公开结果必须返回 `reference_origin`、通用方向字段和参考点云格式。PCD 保持原点为零，并继续返回既有 `pcd_to_ply`／`ply_to_pcd` 兼容字段，确保历史调用不变。

### 18.3 验证

- 同一批坐标写成 LAS 与 LAZ 后，解码点数、世界包围盒和逐点坐标必须一致。
- 使用大地坐标合成数据验证局部化前后矩阵组合，PLY→参考世界坐标往返误差使用双精度评估。
- 使用真实 LAS／LAZ 与 CloudCompare 对比点数、包围盒、RMS 和矩阵；ICP RMS 不能替代控制点或实飞精度验收。

## 19．通用双模型双向配准

- 模型 A、模型 B 均支持 PLY、PCD、LAS、LAZ，文件格式不决定 ICP 角色。
- 业务输出方向与 ICP 移动方向分离；用户可选择 `A_TO_B`／`B_TO_A`，并独立选择 `A`／`B`／`AUTO` 作为移动模型。
- `AUTO` 只根据点数和包围盒范围给出推荐，不限制用户覆盖。
- ICP 始终计算 `T_moving_local_to_fixed_local`；服务用 `origin_a` 和 `origin_b` 组合 `T_a_to_b`，并通过求逆得到 `T_b_to_a`。
- 若 A 为移动模型：`T_a_to_b = Translate(origin_b) × T_a_local_to_b_local × Translate(-origin_a)`。
- 若 B 为移动模型：先组合 `T_b_to_a`，再求逆得到 `T_a_to_b`。
- 新接口使用 `/api/v2` 和 `model_a`／`model_b`；现有 `/api/v1` PLY＋参考点云接口保持兼容。

## 20．ICP 实时过程可视化

- CCCoreLib 只在本轮变换被接受后调用可选回调，报告迭代序号、RMS、有效点数和累计变换；关闭回调时计算路径保持不变。
- C++ 适配层把累计增量与人工初始矩阵组合成完整 `T_moving_local_to_fixed_local`，Worker 以 JSON Lines 输出，不写入最终业务矩阵文件。
- FastAPI 将逐轮消息写入任务目录并通过 SSE 转发；任务状态和最终结果仍沿用异步查询接口。
- 通用任务始终生成轻量逐轮事件；PlayCanvas 默认关闭过程显示，但运行期间可随时开启或关闭。中途开启使用 `from_latest=true` 直接接入最新一轮，不回放历史；成功时以最终矩阵覆盖，取消时明确标记最后姿态未收敛且不可用于航点转换。
- 逐轮状态显示在三维视口工具栏下方；当前移动／固定模型和颜色说明显示在左侧第 1 步“模型”区域。当移动模型包围盒对角线达到固定模型的 `1.25` 倍时，前端显式提示大范围点云移动匹配小范围点云的局部最优风险，并建议交换 ICP 角色，不改变用户选择的业务输出方向。
- 视口左上角第一排粗配准工具栏末尾提供模型 A、B 的独立显示开关；隐藏只设置 PlayCanvas 实体可见性，不修改点云或矩阵，隐藏移动模型时同步卸载其变换手柄，ICP 运行期间仍允许切换。
- 验证必须证明开启与关闭进度输出时最终矩阵和 RMS 完全一致，并覆盖 SSE、取消和前端控件恢复。
