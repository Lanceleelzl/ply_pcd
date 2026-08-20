// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/point_cloud.hpp"

#include <cstddef>
#include <filesystem>
#include <vector>

namespace registration
{
struct PreviewResult
{
    std::size_t sourcePointCount = 0;
    std::size_t previewPointCount = 0;
    BoundingBox bounds;
    std::vector<std::size_t> selectedIndices;
};

class PointCloudPreview
{
public:
    [[nodiscard]] PreviewResult write(const PointCloud& cloud,
                                      std::size_t pointLimit,
                                      const std::filesystem::path& path) const;
};
} // namespace registration
