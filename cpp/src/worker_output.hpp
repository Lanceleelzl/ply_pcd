// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/matrix.hpp"
#include "registration/point_cloud.hpp"

#include <cstdint>
#include <iosfwd>
#include <string>

namespace registration::worker
{
void writeMatrixJson(std::ostream& output, const Matrix4d& matrix, int indent);
void writeCompactMatrixJson(std::ostream& output, const Matrix4d& matrix);
void printCloudSummary(const std::string& type,
                       std::uint64_t declared,
                       std::uint64_t valid,
                       std::uint64_t invalid,
                       const BoundingBox& box);
} // namespace registration::worker
