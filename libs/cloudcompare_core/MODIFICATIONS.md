# Modifications

已修改：

```text
include/CloudSamplingTools.h
src/CloudSamplingTools.cpp
```

修改内容：增加可配置随机种子，并用固定种子的 `std::mt19937` 替代 `std::random_device` 初始化，使同一任务输入和参数得到可复现结果。随机抽样算法和抽样数量保持不变。

本项目通过独立适配层完成：

- 将项目点云转换为 `CCCoreLib::PointCloud`。
- 固定 PLY 为 model、PCD 为 data。
- 固定点云到点云 ICP，不启用 Mesh 分支。
- 将 `ScaledTransformation` 转为方向明确的 `pcdToPly` 矩阵。
- 计算并验证 `plyToPcd` 逆矩阵。
- 关闭 Qt Concurrent、TBB 和 CGAL。

后续若修改上游文件，必须在此逐文件记录。
