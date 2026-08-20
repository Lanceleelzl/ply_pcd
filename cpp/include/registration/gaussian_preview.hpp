// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <cstddef>
#include <filesystem>
#include <vector>

namespace registration
{
class GaussianPreview
{
public:
    void write(const std::filesystem::path& source,
               const std::vector<std::size_t>& selectedIndices,
               const std::filesystem::path& destination) const;
};
} // namespace registration
