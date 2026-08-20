// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <array>
#include <cstddef>
#include <vector>

namespace registration
{
using Point3f = std::array<float, 3>;

struct BoundingBox
{
    Point3f min{};
    Point3f max{};
};

struct PointCloud
{
    std::vector<Point3f> points;

    [[nodiscard]] BoundingBox boundingBox() const;
};
} // namespace registration

