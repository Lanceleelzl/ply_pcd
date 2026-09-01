// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/reference_cloud_reader.hpp"

namespace registration
{
class LasReader
{
public:
    [[nodiscard]] ReferenceCloudReadResult read(const std::filesystem::path& path) const;
};
} // namespace registration
