// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/point_cloud.hpp"

#include <cstdint>
#include <filesystem>

namespace registration
{
struct PlyReadResult
{
    PointCloud cloud;
    std::uint64_t declaredVertexCount = 0;
    std::uint64_t invalidPointCount = 0;
};

class PlyReader
{
public:
    [[nodiscard]] PlyReadResult read(const std::filesystem::path& path) const;
};
} // namespace registration

