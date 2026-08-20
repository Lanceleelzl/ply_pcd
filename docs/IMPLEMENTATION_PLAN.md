# PLY／PCD 坐标配准服务实施方案

## 1．目标与边界

### 1.1 输入

- 室内扫描设备生成的 Gaussian Splatting PLY。
- 无人机机载雷达 SLAM 生成的 PCD 全局定位地图。
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
