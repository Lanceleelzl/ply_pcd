// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/point_cloud.hpp"

#include <array>
#include <cstdint>
#include <filesystem>
#include <string>

namespace registration
{
using Point3d = std::array<double, 3>;

struct BoundingBox3d
{
    Point3d min{};
    Point3d max{};
};

struct ReferenceCloudReadResult
{
    PointCloud cloud;
    std::string format;
    std::uint64_t declaredPointCount = 0;
    std::uint64_t invalidPointCount = 0;
    Point3d origin{};
    BoundingBox3d worldBounds{};
};

class ReferenceCloudReader
{
public:
    [[nodiscard]] ReferenceCloudReadResult read(const std::filesystem::path& path) const;
};
} // namespace registration
