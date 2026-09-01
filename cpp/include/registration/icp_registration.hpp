// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/matrix.hpp"
#include "registration/point_cloud.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>

namespace registration
{
struct IcpIterationState
{
    unsigned iteration = 0;
    double rms = -1.0;
    unsigned pointCount = 0;
    Matrix4d movingLocalToFixedLocal;
};

struct IcpOptions
{
    double minRmsDecrease = 1.0e-5;
    unsigned maxIterations = 0;
    unsigned samplingLimit = 50000;
    double finalOverlapRatio = 1.0;
    bool adjustScale = false;
    bool filterOutFarthestPoints = false;
    int maxThreadCount = 0;
    std::uint32_t randomSeed = 42;
    Matrix4d initialMovingLocalToFixedLocal;
    Matrix4d initialPcdToPly;
    std::function<void(const IcpIterationState&)> iterationCallback;
};

struct IcpResult
{
    Matrix4d initialMovingLocalToFixedLocal;
    Matrix4d refinementMovingLocalToFixedLocal;
    Matrix4d movingLocalToFixedLocal;
    Matrix4d fixedLocalToMovingLocal;
    Matrix4d initialPcdToPly;
    Matrix4d refinementPcdToPly;
    Matrix4d pcdToPly;
    Matrix4d plyToPcd;
    double scale = 1.0;
    double finalRms = -1.0;
    unsigned finalPointCount = 0;
};

class IcpRegistration
{
public:
    [[nodiscard]] IcpResult registerMovingToFixed(const PointCloud& moving,
                                                  const PointCloud& fixed,
                                                  const IcpOptions& options = {}) const;
    [[nodiscard]] IcpResult registerPcdToPly(const PointCloud& pcd,
                                             const PointCloud& ply,
                                             const IcpOptions& options = {}) const;
};
} // namespace registration
