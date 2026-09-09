// SPDX-License-Identifier: GPL-3.0-or-later
#include "worker_output.hpp"

#include <iomanip>
#include <iostream>

namespace registration::worker
{
void writeMatrixJson(std::ostream& output, const Matrix4d& matrix, int indent)
{
    output << "[\n";
    for (std::size_t row = 0; row < 4; ++row)
    {
        output << std::string(static_cast<std::size_t>(indent + 2), ' ') << '[';
        for (std::size_t column = 0; column < 4; ++column)
        {
            if (column != 0) output << ", ";
            output << matrix.at(row, column);
        }
        output << ']' << (row == 3 ? "\n" : ",\n");
    }
    output << std::string(static_cast<std::size_t>(indent), ' ') << ']';
}

void writeCompactMatrixJson(std::ostream& output, const Matrix4d& matrix)
{
    output << '[';
    for (std::size_t row = 0; row < 4; ++row)
    {
        if (row != 0) output << ',';
        output << '[';
        for (std::size_t column = 0; column < 4; ++column)
        {
            if (column != 0) output << ',';
            output << matrix.at(row, column);
        }
        output << ']';
    }
    output << ']';
}

void printCloudSummary(const std::string& type,
                       std::uint64_t declared,
                       std::uint64_t valid,
                       std::uint64_t invalid,
                       const BoundingBox& box)
{
    std::cout << std::fixed << std::setprecision(6)
              << "{\n"
              << "  \"type\": \"" << type << "\",\n"
              << "  \"declared_points\": " << declared << ",\n"
              << "  \"valid_points\": " << valid << ",\n"
              << "  \"invalid_points\": " << invalid << ",\n"
              << "  \"bounds\": {\n"
              << "    \"min\": [" << box.min[0] << ", " << box.min[1] << ", " << box.min[2] << "],\n"
              << "    \"max\": [" << box.max[0] << ", " << box.max[1] << ", " << box.max[2] << "]\n"
              << "  }\n"
              << "}\n";
}
} // namespace registration::worker
