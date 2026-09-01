// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/reference_cloud_reader.hpp"

#include "registration/las_reader.hpp"
#include "registration/pcd_reader.hpp"
#include "registration/ply_reader.hpp"

#include <algorithm>
#include <cctype>
#include <stdexcept>
#include <utility>

namespace registration
{
ReferenceCloudReadResult ReferenceCloudReader::read(const std::filesystem::path& path) const
{
    auto extension = path.extension().string();
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char value) { return static_cast<char>(std::tolower(value)); });
    if (extension == ".las" || extension == ".laz")
    {
        return LasReader().read(path);
    }
    if (extension == ".pcd")
    {
        auto pcd = PcdReader().read(path);
        ReferenceCloudReadResult result;
        result.cloud = std::move(pcd.cloud);
        result.format = "pcd";
        result.declaredPointCount = pcd.declaredPointCount;
        result.invalidPointCount = pcd.invalidPointCount;
        const auto bounds = result.cloud.boundingBox();
        for (std::size_t axis = 0; axis < 3; ++axis)
        {
            result.worldBounds.min[axis] = bounds.min[axis];
            result.worldBounds.max[axis] = bounds.max[axis];
        }
        return result;
    }
    if (extension == ".ply")
    {
        auto ply = PlyReader().read(path);
        ReferenceCloudReadResult result;
        result.cloud = std::move(ply.cloud);
        result.format = "ply";
        result.declaredPointCount = ply.declaredVertexCount;
        result.invalidPointCount = ply.invalidPointCount;
        const auto bounds = result.cloud.boundingBox();
        for (std::size_t axis = 0; axis < 3; ++axis)
        {
            result.worldBounds.min[axis] = bounds.min[axis];
            result.worldBounds.max[axis] = bounds.max[axis];
        }
        return result;
    }
    throw std::runtime_error("Point cloud must use .ply, .pcd, .las, or .laz extension");
}
} // namespace registration
