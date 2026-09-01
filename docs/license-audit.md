# 源码许可证审计

## 审计基线

```text
CloudCompare commit：da62b8e0155cee4237335476477cb1088c54c2f3
版本：v2.13.1-430-gda62b8e0
审计日期：2026-09-01
```

## 已进入项目的上游源码

| 本项目路径 | 上游路径 | 许可证 | 修改 |
|---|---|---|---|
| `libs/cloudcompare_core/include` | `libs/qCC_db/extern/CCCoreLib/include` | LGPL-2.0-or-later | `CloudSamplingTools.h` 增加随机种子接口 |
| `libs/cloudcompare_core/src` | `libs/qCC_db/extern/CCCoreLib/src` | LGPL-2.0-or-later | `CloudSamplingTools.cpp` 使用可配置固定种子 |
| `libs/cloudcompare_core/extern/nanoflann` | 同名上游目录 | BSD | 未修改 |
| `libs/cloudcompare_core/cmake` | 同名上游目录 | MIT | 未修改 |
| `cpp/vendor/laszip` | LASzip 官方 tag `3.5.0`，commit `fa089bd8b2b4ca5631e199d257374c32a125f73f` | Apache-2.0 | 未修改 |

## 项目侧适配

以下文件为本项目新代码，采用 GPL-3.0-or-later：

```text
cpp/include/registration/icp_registration.hpp
cpp/src/icp_registration.cpp
cpp/include/registration/las_reader.hpp
cpp/include/registration/reference_cloud_reader.hpp
cpp/src/las_reader.cpp
cpp/src/reference_cloud_reader.cpp
```

适配层固定：

```text
PLY = model，不移动
PCD = data，移动
输出 T_pcd_to_ply
求逆输出 T_ply_to_pcd
```

## 尚未提取

- CloudCompare `PlyFilter`。
- CloudCompare `PcdFilter`。
- CloudCompare GUI、CLI、插件和 qCC_db。
- Qt、PCL、CGAL 和 OpenGL 相关代码。

当前 PLY／PCD Reader 为项目新实现，没有复制上述 Filter 文件。LAS／LAZ Reader 为项目新适配代码，仅调用 LASzip 官方 C API。
