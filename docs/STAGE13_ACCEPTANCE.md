# 阶段 13：数据格式扩展验收记录

## 1．结论

阶段 13 已完成普通 PLY、Gaussian PLY、PlayCanvas compressed PLY、PCD、LAS／LAZ、SOG、Streamed SOG、LCC 5.0 和 LCC2 0.0.3 的接入、计算通道、显示通道及 Windows／Docker Linux 验收。

所有 Gaussian 格式只提供显示资源。粗配准和 ICP 始终读取独立解析出的 XYZ 点云，不读取颜色、SH、尺度、旋转、环境、网格或 BVH 数据参与计算。显示模式、相机和浏览器选择的 LOD 不会改变计算点集。

## 2．上传契约

模型 A、模型 B 分别支持以下形态，每个模型必须二选一：

1. 单文件字段：`model_a`／`model_b`，用于 `.ply`、`.pcd`、`.las`、`.laz`、bundled `.sog` 或数据集 `.zip`。
2. 目录字段：重复的 `model_a_files`／`model_b_files`，每个 multipart part 的 `filename` 是所选根目录内的相对路径。

目录上传必须选择只包含一个场景入口的目录。例如同时包含 `render/*.lcc` 和 `render2/*.lcc2` 的共同上层目录会因入口类型歧义被拒绝，应分别选择 `render` 或 `render2`。

服务端拒绝绝对路径、父目录跳转、重复路径、符号链接、加密 ZIP、超过 100,000 个文件、解压后超过 100 GiB 或压缩比超过 200 的数据集。目录上传会先封装为 ZIP，再解压到会话数据目录，因此部署容量应按源数据、内部 ZIP、解压数据、计算 PLY 和显示转换资源的峰值总量规划。

## 3．格式边界

| 格式 | 入口 | XYZ 计算 | Gaussian 显示 | 流式显示 |
| --- | --- | --- | --- | --- |
| 普通 PLY | 单个 `.ply` | 原文件 | 不提供 | 否 |
| Gaussian PLY | 单个 `.ply` | XYZ 属性 | 原文件 | 否 |
| compressed PLY | 单个 `.ply` | 解码为 PLY | 原文件 | 否 |
| PCD／LAS／LAZ | 单文件 | 原文件 | 不提供 | 否 |
| bundled SOG v2 | 单个 `.sog` | 解码为 PLY | 原文件 | 否 |
| Streamed SOG v1 | `lod-meta.json` | 固定最粗 LOD 解码为 PLY | 原资源树 | 是 |
| LCC 5.0 | 一个 `.lcc`＋伴随二进制 | 固定 `totalLevel - 1` 解码为 PLY | 转换为 Streamed SOG | 是 |
| LCC2 0.0.3 | 一个 `.lcc2`＋引用块 | 固定 `totalLevels - 1` 解码为 PLY | 转换为 Streamed SOG | 是 |

计算 LOD 由数据集元数据确定，并作为 `compute_lod` 写入会话状态。LCC／LCC2 的显示转换失败不会撤销已经就绪的 XYZ；此时仍可进行中心点预览、粗配准和 ICP。

## 4．真实数据验证

| 数据 | 原始规模 | 计算 LOD | 解码点数 | 无效点 |
| --- | ---: | ---: | ---: | ---: |
| Streamed SOG | 987,836,547 字节，817 个文件 | 3 | 4,409,286 | 0 |
| LCC 5.0 Portable | 101,614,037 个最高精度 splats | 6 | 1,517,478 | 0 |
| LCC2 0.0.3 | 240,740,283 个总 splats | 8 | 448,957 | 0 |

三份数据在 Windows 和 Docker Linux 中均由 SplatTransform 3.4.2 解码，再由各平台的 `registration_worker inspect-ply` 读取。两平台点数和包围盒一致。

真实 Streamed SOG 的 `lod-meta.json` 没有顶层 `version`。当前探测依据 `lodLevels`、`filenames` 和 `tree`，并递归检查二叉空间树、SOG v2 块、WebP 引用、文件索引、区间边界及每个块无缺口且不重叠。

## 5．回归与运行验收

- 服务回归：94／94。
- 可由 Node 直接执行的 Web 回归：109／109。
- TypeScript 类型检查：通过。
- Vite 生产构建：通过。
- Windows CTest：1／1。
- Docker Desktop `desktop-linux` 镜像构建：通过。
- 容器首页与 OpenAPI：HTTP 200。
- 容器双角色业务坐标 ICP：RMS `7.41627e-07`／`5.04159e-07`。
- Playwright 独立 Chrome：页面显示“服务正常”，上传入口存在，控制台 0 error。

`coordinate-query-views.test.ts` 仍因既有无扩展名 ESM 导入不能由 Node 原生测试加载；Vue 类型检查和 Vite 构建已覆盖其编译边界。该问题不属于数据格式扩展改动。

## 6．运行状态

验收时 compose 服务运行在 `http://127.0.0.1:8865`，镜像为 `ply-pcd-registration:dev`。运行状态是本次验收快照，不作为后续时刻服务仍然在线的保证。
