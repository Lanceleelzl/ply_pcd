// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/point_cloud_preview.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <limits>
#include <numeric>
#include <stdexcept>
#include <unordered_set>
#include <utility>
#include <vector>

namespace registration
{
namespace
{
struct Cell
{
    std::int64_t x;
    std::int64_t y;
    std::int64_t z;

    bool operator==(const Cell& other) const
    {
        return x == other.x && y == other.y && z == other.z;
    }
};

struct CellHash
{
    std::size_t operator()(const Cell& cell) const
    {
        std::size_t seed = std::hash<std::int64_t>{}(cell.x);
        seed ^= std::hash<std::int64_t>{}(cell.y) + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
        seed ^= std::hash<std::int64_t>{}(cell.z) + 0x9e3779b9U + (seed << 6U) + (seed >> 2U);
        return seed;
    }
};

std::vector<std::size_t> sample(const PointCloud& cloud, std::size_t limit)
{
    if (limit < 3) throw std::runtime_error("Preview point limit must be at least 3");
    if (cloud.points.size() <= limit)
    {
        std::vector<std::size_t> all(cloud.points.size());
        std::iota(all.begin(), all.end(), std::size_t{0});
        return all;
    }

    const auto bounds = cloud.boundingBox();
    const double dx = static_cast<double>(bounds.max[0]) - bounds.min[0];
    const double dy = static_cast<double>(bounds.max[1]) - bounds.min[1];
    const double dz = static_cast<double>(bounds.max[2]) - bounds.min[2];
    const double diagonal = std::sqrt(dx * dx + dy * dy + dz * dz);
    double voxelSize = diagonal / std::cbrt(static_cast<double>(limit));
    if (!(voxelSize > 0.0)) voxelSize = 1.0;

    const auto selectAtSize = [&](double size) {
        std::vector<std::size_t> selected;
        selected.reserve(limit);
        std::unordered_set<Cell, CellHash> occupied;
        occupied.reserve(limit * 2);
        for (std::size_t index = 0; index < cloud.points.size(); ++index)
        {
            const auto& point = cloud.points[index];
            const Cell cell{
                static_cast<std::int64_t>(std::floor((point[0] - bounds.min[0]) / size)),
                static_cast<std::int64_t>(std::floor((point[1] - bounds.min[1]) / size)),
                static_cast<std::int64_t>(std::floor((point[2] - bounds.min[2]) / size))};
            if (occupied.insert(cell).second) selected.push_back(index);
            if (selected.size() > limit) break;
        }
        return selected;
    };

    auto upperSelection = selectAtSize(voxelSize);
    double upperSize = voxelSize;
    double lowerSize = voxelSize;
    if (upperSelection.size() <= limit)
    {
        for (unsigned attempt = 0; attempt < 24; ++attempt)
        {
            lowerSize = upperSize * 0.5;
            auto lowerSelection = selectAtSize(lowerSize);
            if (lowerSelection.size() > limit) break;
            upperSize = lowerSize;
            upperSelection = std::move(lowerSelection);
        }
    }
    else
    {
        for (unsigned attempt = 0; attempt < 24; ++attempt)
        {
            upperSize *= 2.0;
            upperSelection = selectAtSize(upperSize);
            if (upperSelection.size() <= limit)
            {
                lowerSize = upperSize * 0.5;
                break;
            }
        }
    }
    if (upperSelection.size() > limit)
        throw std::runtime_error("Unable to find a preview voxel size below the point limit");

    for (unsigned attempt = 0; attempt < 12; ++attempt)
    {
        const double middle = (lowerSize + upperSize) * 0.5;
        auto middleSelection = selectAtSize(middle);
        if (middleSelection.size() > limit)
        {
            lowerSize = middle;
        }
        else
        {
            upperSize = middle;
            upperSelection = std::move(middleSelection);
        }
    }
    return upperSelection;
}

template <typename T>
void writeValue(std::ofstream& output, const T& value)
{
    output.write(reinterpret_cast<const char*>(&value), sizeof(T));
}
} // namespace

PreviewResult PointCloudPreview::write(const PointCloud& cloud,
                                       std::size_t pointLimit,
                                       const std::filesystem::path& path) const
{
    if (cloud.points.empty()) throw std::runtime_error("Cannot preview an empty point cloud");
    auto indices = sample(cloud, pointLimit);
    const auto bounds = cloud.boundingBox();
    std::ofstream output(path, std::ios::binary);
    if (!output) throw std::runtime_error("Cannot create point cloud preview: " + path.string());
    constexpr char magic[8] = {'P', 'C', 'P', 'V', '0', '0', '0', '1'};
    output.write(magic, sizeof(magic));
    const auto count = static_cast<std::uint32_t>(indices.size());
    constexpr std::uint32_t stride = sizeof(Point3f);
    writeValue(output, count);
    writeValue(output, stride);
    for (const float value : bounds.min) writeValue(output, value);
    for (const float value : bounds.max) writeValue(output, value);
    for (const auto index : indices)
    {
        const auto& point = cloud.points[index];
        output.write(reinterpret_cast<const char*>(point.data()), sizeof(Point3f));
    }
    if (!output) throw std::runtime_error("Failed while writing point cloud preview: " + path.string());
    return {cloud.points.size(), indices.size(), bounds, std::move(indices)};
}
} // namespace registration
