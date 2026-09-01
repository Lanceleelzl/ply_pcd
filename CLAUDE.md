# 项目开发规范

## 项目目标

本项目实现一个可部署到服务器的通用点云坐标配准服务。模型 A、模型 B 均支持 PLY、PCD、LAS 和 LAZ。

输入为两个点云模型，输出 `T_a_to_b` 和 `T_b_to_a` 两个世界坐标系之间的 `4×4` 齐次矩阵。

业务矩阵方向和 ICP 对齐角色必须分离：

```text
业务方向：A→B 或 B→A
ICP 角色：A 移动／B 固定，或 B 移动／A 固定
```

ICP 只计算：

```text
T_moving_local_to_fixed_local
```

服务必须组合两个模型各自的双精度原点并同时返回：

```text
T_a_to_b
T_b_to_a = inverse(T_a_to_b)
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
- LAS／LAZ 使用项目内固定版本的 LASzip 官方源码解析，不依赖系统安装的 LASzip。
- ICP 行为和混合精度与本地 CloudCompare 版本保持一致。
- Windows 使用 Visual Studio 2022 开发和调试。
- Windows 普通使用者通过 `pnpm install` 使用仓库内预编译静态 Worker，不要求安装 Visual Studio、CMake 或 Python。
- `pnpm run build:native` 在 VS2022 环境编译并替换预编译 Worker，同时更新源码指纹和 SHA-256 清单。
- 本地 Python 由项目内固定版本 uv 管理，依赖以 `uv.lock` 为准，不修改系统 Python 和 PATH。
- 本地服务端口由 `config/local.json` 管理，监听地址固定为 `127.0.0.1`。
- Docker Desktop 构建 Linux 镜像，最终以同一 Linux 镜像部署到服务器。
- 人工粗配准功能在 `feat/manual-coarse-registration` 分支开发，完成验证前不合并 `main`。
- 粗配准只允许操作当前选定的 ICP 移动模型，不允许人工缩放；文件格式不得决定移动／固定角色。
- 浏览器默认加载由原始数据生成的轻量点云预览；Gaussian 效果使用同一采样集合，预览数据不参与最终 ICP。
- 人工矩阵方向固定为 `T_initial_moving_local_to_fixed_local`；ICP 最终组合为 `T_moving_local_to_fixed_local = T_icp_delta * T_initial_moving_local_to_fixed_local`。
- 前端三维引擎使用 PlayCanvas；PCD 解析继续复用项目 C++ 解析器，不引入第二套 PCD 解析库。
- 浏览器不直接解析 LAZ；C++ Worker 将 PCD／LAS／LAZ 统一转换为轻量预览协议。
- ICP 实时过程只报告已接受迭代的 `T_moving_local_to_fixed_local`，不得改变采样、收敛或最终矩阵；最终业务结果始终以任务成功响应中的世界坐标矩阵为准。
- 通用 v2 配准任务始终生成轻量迭代事件；“在三维场景中显示配准过程”只控制浏览器订阅和显示，运行期间可随时开启或关闭，不得作为会影响 Worker 计算的锁定参数。
- 在旧版服务端仍按 `show_registration_progress` 决定 Worker 输出的兼容期内，新版前端提交 v2 任务时固定发送 `show_registration_progress=true`；用户勾选状态仍只控制浏览器显示。
- 当前移动模型包围盒对角线明显大于固定模型时，前端必须提示“大范围移动匹配小范围”的局部最优风险，并建议交换 ICP 角色；业务输出方向与 ICP 角色保持独立，可直接使用服务返回的对应正向或反向矩阵。
- 通用三维视口必须允许独立显示或隐藏模型 A、模型 B；该控制仅改变 PlayCanvas 可见性，在 ICP 运行期间保持可用，不改变输入点云、模型矩阵或最终结果。隐藏当前移动模型时同步隐藏变换手柄。
- 当前移动／固定模型及黄色／灰色说明显示在左侧第 1 步“模型”区域，不占用三维视口；其内容必须随 ICP 移动角色选择同步更新。

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

两个模型的世界坐标都必须在转换为 ICP 所需的 `float32` 前减去各自确定性的双精度局部原点。LAS／LAZ 必须先以 `float64` 应用文件头 scale／offset。最终业务矩阵必须在 `float64` 中恢复两个原点，禁止把大地坐标直接转换为 `float32`。

## 许可证规则

- 项目整体计划采用 `GPL-3.0-or-later`。
- 提取的 CCCoreLib 文件保留其 `LGPL-2.0-or-later` 文件级声明。
- 派生自 CloudCompare `PlyFilter`／`PcdFilter` 的代码保留其原始 GPL 和版权声明。
- `rply` 保留 MIT 许可证和原始版权声明。
- nanoflann 若实际进入依赖闭包，保留 BSD 许可证声明。
- LASzip 固定为官方 `3.5.0`（commit `fa089bd8b2b4ca5631e199d257374c32a125f73f`），保留 Apache-2.0 许可证与上游声明。
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
- v2 公开字段应使用 `aToB`、`bToA`、`movingLocalToFixedLocal` 等方向明确的名称；PCD／PLY 专用字段只允许保留在 v1 兼容层。
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
