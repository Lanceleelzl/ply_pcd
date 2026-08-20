// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/point_cloud.hpp"

#include <cstdint>
#include <filesystem>

namespace registration
{
struct PcdReadResult
{
    PointCloud cloud;
    std::uint64_t declaredPointCount = 0;
    std::uint64_t invalidPointCount = 0;
};

class PcdReader
{
public:
    [[nodiscard]] PcdReadResult read(const std::filesystem::path& path) const;
};
} // namespace registration

