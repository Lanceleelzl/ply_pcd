// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/las_reader.hpp"

#include <laszip_api.h>

#include <cmath>
#include <limits>
#include <stdexcept>
#include <string>

namespace registration
{
namespace
{
std::string errorMessage(laszip_POINTER reader, const std::string& operation)
{
    laszip_CHAR* detail = nullptr;
    if (reader && laszip_get_error(reader, &detail) == 0 && detail)
        return operation + ": " + detail;
    return operation;
}

class LaszipReaderHandle
{
public:
    LaszipReaderHandle()
    {
        if (laszip_create(&reader_) != 0) throw std::runtime_error("LASzip reader creation failed");
    }

    ~LaszipReaderHandle()
    {
        if (opened_) laszip_close_reader(reader_);
        if (reader_) laszip_destroy(reader_);
    }

    LaszipReaderHandle(const LaszipReaderHandle&) = delete;
    LaszipReaderHandle& operator=(const LaszipReaderHandle&) = delete;

    laszip_POINTER get() const { return reader_; }
    void markOpened() { opened_ = true; }

private:
    laszip_POINTER reader_ = nullptr;
    bool opened_ = false;
};
} // namespace

ReferenceCloudReadResult LasReader::read(const std::filesystem::path& path) const
{
    LaszipReaderHandle handle;
    laszip_BOOL compressed = 0;
    const auto nativePath = path.string();
    if (laszip_open_reader(handle.get(), nativePath.c_str(), &compressed) != 0)
        throw std::runtime_error(errorMessage(handle.get(), "Cannot open LAS/LAZ file"));
    handle.markOpened();

    laszip_header_struct* header = nullptr;
    if (laszip_get_header_pointer(handle.get(), &header) != 0 || !header)
        throw std::runtime_error(errorMessage(handle.get(), "Cannot read LAS/LAZ header"));
    if (header->point_data_format > 10)
        throw std::runtime_error("Unsupported LAS point data format: " + std::to_string(header->point_data_format));

    const std::uint64_t pointCount = header->extended_number_of_point_records != 0
        ? header->extended_number_of_point_records
        : header->number_of_point_records;
    if (pointCount < 3) throw std::runtime_error("LAS/LAZ point cloud must contain at least 3 points");
    if (pointCount > static_cast<std::uint64_t>(std::numeric_limits<std::size_t>::max()))
        throw std::runtime_error("LAS/LAZ point count exceeds addressable memory");

    ReferenceCloudReadResult result;
    result.format = compressed ? "laz" : "las";
    result.declaredPointCount = pointCount;
    result.worldBounds.min = {header->min_x, header->min_y, header->min_z};
    result.worldBounds.max = {header->max_x, header->max_y, header->max_z};
    for (std::size_t axis = 0; axis < 3; ++axis)
    {
        if (!std::isfinite(result.worldBounds.min[axis]) || !std::isfinite(result.worldBounds.max[axis])
            || result.worldBounds.min[axis] > result.worldBounds.max[axis])
            throw std::runtime_error("LAS/LAZ header contains invalid bounds");
        result.origin[axis] = result.worldBounds.min[axis]
            + (result.worldBounds.max[axis] - result.worldBounds.min[axis]) * 0.5;
    }

    result.cloud.points.reserve(static_cast<std::size_t>(pointCount));
    for (std::uint64_t index = 0; index < pointCount; ++index)
    {
        if (laszip_read_point(handle.get()) != 0)
            throw std::runtime_error(errorMessage(handle.get(), "LAS/LAZ file ended before all points were read"));
        laszip_F64 coordinates[3]{};
        if (laszip_get_coordinates(handle.get(), coordinates) != 0)
            throw std::runtime_error(errorMessage(handle.get(), "Cannot decode LAS/LAZ coordinates"));
        if (!std::isfinite(coordinates[0]) || !std::isfinite(coordinates[1]) || !std::isfinite(coordinates[2]))
        {
            ++result.invalidPointCount;
            continue;
        }
        result.cloud.points.push_back({
            static_cast<float>(coordinates[0] - result.origin[0]),
            static_cast<float>(coordinates[1] - result.origin[1]),
            static_cast<float>(coordinates[2] - result.origin[2])});
    }
    if (result.cloud.points.size() < 3)
        throw std::runtime_error("LAS/LAZ contains fewer than 3 valid coordinates");
    return result;
}
} // namespace registration
