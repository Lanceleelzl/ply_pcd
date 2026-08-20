// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/point_cloud.hpp"

#include <algorithm>
#include <limits>

namespace registration
{
BoundingBox PointCloud::boundingBox() const
{
    BoundingBox box;
    box.min.fill(std::numeric_limits<float>::infinity());
    box.max.fill(-std::numeric_limits<float>::infinity());
    for (const auto& point : points)
    {
        for (std::size_t axis = 0; axis < 3; ++axis)
        {
            box.min[axis] = std::min(box.min[axis], point[axis]);
            box.max[axis] = std::max(box.max[axis], point[axis]);
        }
    }
    return box;
}
} // namespace registration

