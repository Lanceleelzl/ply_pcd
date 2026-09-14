# Modifications

已修改：

```text
include/CloudSamplingTools.h
src/CloudSamplingTools.cpp
include/RegistrationTools.h
src/RegistrationTools.cpp
```

修改内容：增加可配置随机种子，并用固定种子的 `std::mt19937` 替代 `std::random_device` 初始化，使同一任务输入和参数得到可复现结果。随机抽样算法和抽样数量保持不变。

`RegistrationTools` 增加可选的已接受迭代回调。回调仅在 ICP 接受本轮累计刚体变换后触发，报告迭代序号、RMS、有效点数和累计 `ScaledTransformation`；回调为空时原始计算路径不变，服务用它只读输出三维视口进度。

`FPCSRegistrationTools::RegisterClouds` 增加可选随机种子参数。调用方传入非零种子时，原始 4PCS 的基选择可复现；未传入时保留上游按当前时间初始化的行为。算法搜索、候选过滤和评分逻辑不变。

本项目通过独立适配层完成：

- 将项目点云转换为 `CCCoreLib::PointCloud`。
- 固定 PLY 为 model、PCD 为 data。
- 固定点云到点云 ICP，不启用 Mesh 分支。
- 将 `ScaledTransformation` 转为方向明确的 `pcdToPly` 矩阵。
- 计算并验证 `plyToPcd` 逆矩阵。
- 关闭 Qt Concurrent、TBB 和 CGAL。

后续若修改上游文件，必须在此逐文件记录。
