# Third-party notices

## CloudCompare CCCoreLib

```text
来源：https://github.com/CloudCompare/CloudCompare
commit：da62b8e0155cee4237335476477cb1088c54c2f3
本地上游：E:\Geosv_space\CloudCompare\libs\qCC_db\extern\CCCoreLib
许可证：LGPL-2.0-or-later，按文件级 SPDX 声明为准
```

本项目提取 CCCoreLib 源码并直接参与编译，不依赖外部 CloudCompare 安装。具体来源和修改见：

```text
libs/cloudcompare_core/SOURCE_INFO.md
libs/cloudcompare_core/MODIFICATIONS.md
```

## nanoflann

CCCoreLib 内含 nanoflann，采用 BSD 许可证。许可证正文位于：

```text
LICENSES/BSD-nanoflann.txt
```

## LASzip

```text
来源：https://github.com/LASzip/LASzip
版本：3.5.0
commit：fa089bd8b2b4ca5631e199d257374c32a125f73f
许可证：Apache-2.0
```

官方源码保存在 `cpp/vendor/laszip` 并静态参与编译，用于读取 LAS／LAZ 定位参考点云。本项目未修改 LASzip 源文件。许可证正文位于：

```text
LICENSES/Apache-2.0-LASzip.txt
```
