# 项目开发规范

## 项目目标

本项目实现一个可部署到服务器的 PLY／PCD 坐标配准服务。

输入为室内 Gaussian Splatting PLY 模型和无人机 SLAM PCD 地图，输出为将 PLY 坐标转换到 PCD 坐标系的 `4×4` 齐次矩阵。

固定配准方向：

```text
data：PCD，移动
model：PLY，固定
```

配准引擎先求：

```text
T_pcd_to_ply
```

服务最终主要返回：

```text
T_ply_to_pcd = inverse(T_pcd_to_ply)
```

矩阵采用列向量约定：

```text
p_target = T_source_to_target * p_source
```

## 当前实施决策

- 从 `E:\Geosv_space\CloudCompare` 提取配准所需的最小源码闭包，在本项目中裁剪和改造。
- 不链接已编译的 CloudCompare／CCCoreLib 动态库。
- 不启动 CloudCompare GUI 或 CLI。
- 运行环境不要求安装 CloudCompare、Qt、OpenGL、PCL 或桌面环境。
- PLY／PCD 解析器封装为本项目无界面模块。
- ICP 行为和混合精度与本地 CloudCompare 版本保持一致。
- Windows 使用 Visual Studio 2022 开发和调试。
- Windows 普通使用者通过 `pnpm install` 使用仓库内预编译静态 Worker，不要求安装 Visual Studio、CMake 或 Python。
- `pnpm run build:native` 在 VS2022 环境编译并替换预编译 Worker，同时更新源码指纹和 SHA-256 清单。
- 本地 Python 由项目内固定版本 uv 管理，依赖以 `uv.lock` 为准，不修改系统 Python 和 PATH。
- Docker Desktop 构建 Linux 镜像，最终以同一 Linux 镜像部署到服务器。

## 上游基线

```text
路径：E:\Geosv_space\CloudCompare
版本：v2.13.1-430-gda62b8e0
commit：da62b8e0155cee4237335476477cb1088c54c2f3
```

任何源码提取都必须以该 commit 为基线，记录原始路径、许可证和修改内容。

## 数据约束

现有基准数据位于：

```text
source/ply/point_cloud.ply
source/pcd/GlobalMap.pcd
```

- `source` 目录视为原始输入，只读，不覆盖、不重写、不移动。
- 中间文件和任务输出统一写入 `runtime`。
- 测试代码不得依赖用户临时目录。
- 不将真实大体积数据提交到公开 Git 仓库，除非用户明确决定数据许可与发布方式。

## 精度约束

与当前 CloudCompare 保持相同的混合精度路径：

```text
点坐标：float32
标量距离：float64
质心和协方差：float64
旋转、平移和尺度：float64
RMS：float64
累计变换：float64
CloudCompare 兼容矩阵：float32
```

服务同时输出高精度矩阵和 CloudCompare 兼容矩阵。不得为了结果看似一致而降低内部计算精度。

## 许可证规则

- 项目整体计划采用 `GPL-3.0-or-later`。
- 提取的 CCCoreLib 文件保留其 `LGPL-2.0-or-later` 文件级声明。
- 派生自 CloudCompare `PlyFilter`／`PcdFilter` 的代码保留其原始 GPL 和版权声明。
- `rply` 保留 MIT 许可证和原始版权声明。
- nanoflann 若实际进入依赖闭包，保留 BSD 许可证声明。
- 所有提取文件记录在 `docs/license-audit.md`。
- 所有上游修改记录在对应模块的 `MODIFICATIONS.md`。
- 不得删除、替换或弱化上游许可证和版权头。

## 开发纪律

- 开始编码前先阅读 `ROADMAP.md` 和 `docs/IMPLEMENTATION_PLAN.md`。
- 大改动先更新方案文档，经用户确认后实施。
- 只实现当前阶段要求，不提前添加功能。
- 修复问题先建立复现测试，再改代码。
- 所有矩阵接口必须在名称和文档中包含方向。
- 禁止使用含糊名称，例如 `transform`、`resultMatrix` 作为跨模块公开字段。
- 公开字段应使用 `pcdToPly`、`plyToPcd` 等方向明确的名称。
- 配准失败不得返回 `success` 或伪造单位矩阵。
- 随机采样必须允许固定种子并记录到结果中。
- 解析大文件必须流式处理，禁止 API 层将整个上传文件读入内存。

## 验证要求

每次相关改动至少执行对应层级验证：

```text
解析器改动：格式单元测试＋真实文件点数和包围盒检查
矩阵改动：方向、求逆、往返误差测试
ICP 改动：合成变换恢复测试＋真实数据回归测试
服务改动：API 集成测试＋Worker 崩溃隔离测试
Docker 改动：镜像构建＋容器内真实数据回归测试
```

只有通过验证的事项才能写入 `ROADMAP.md` 的“已完成”。

## 红线

- 删除文件、目录或数据前必须先询问用户。
- 修改系统配置、安装全局依赖、修改 CI/CD、发布镜像或公开仓库前必须先询问用户。
- 不修改 `E:\Geosv_space\CloudCompare` 上游工作区。
- 不把密钥、Token、密码写入源码、配置、日志或提交。
