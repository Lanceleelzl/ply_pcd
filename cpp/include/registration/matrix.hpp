// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <array>
#include <filesystem>
#include <string>

namespace registration
{
class Matrix4d
{
public:
    using Storage = std::array<double, 16>;

    Matrix4d();
    explicit Matrix4d(Storage values);

    [[nodiscard]] double& at(std::size_t row, std::size_t column);
    [[nodiscard]] double at(std::size_t row, std::size_t column) const;
    [[nodiscard]] const Storage& values() const;
    [[nodiscard]] Matrix4d inverse() const;
    [[nodiscard]] Matrix4d operator*(const Matrix4d& other) const;
    [[nodiscard]] Matrix4d toFloatCompatible() const;
    [[nodiscard]] std::string toString(int precision = 12) const;

    static Matrix4d fromFile(const std::filesystem::path& path);

private:
    Storage values_{};
};
} // namespace registration
