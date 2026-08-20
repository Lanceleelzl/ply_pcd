// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/matrix.hpp"

#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <utility>

namespace registration
{
Matrix4d::Matrix4d()
{
    for (std::size_t i = 0; i < 4; ++i)
    {
        at(i, i) = 1.0;
    }
}

Matrix4d::Matrix4d(Storage values)
    : values_(std::move(values))
{
}

double& Matrix4d::at(std::size_t row, std::size_t column)
{
    return values_.at(row * 4 + column);
}

double Matrix4d::at(std::size_t row, std::size_t column) const
{
    return values_.at(row * 4 + column);
}

const Matrix4d::Storage& Matrix4d::values() const
{
    return values_;
}

Matrix4d Matrix4d::inverse() const
{
    double augmented[4][8]{};
    for (std::size_t row = 0; row < 4; ++row)
    {
        for (std::size_t column = 0; column < 4; ++column)
        {
            augmented[row][column] = at(row, column);
            augmented[row][column + 4] = row == column ? 1.0 : 0.0;
        }
    }

    for (std::size_t column = 0; column < 4; ++column)
    {
        std::size_t pivot = column;
        for (std::size_t row = column + 1; row < 4; ++row)
        {
            if (std::abs(augmented[row][column]) > std::abs(augmented[pivot][column]))
            {
                pivot = row;
            }
        }
        if (std::abs(augmented[pivot][column]) < 1.0e-15)
        {
            throw std::runtime_error("Matrix is singular");
        }
        if (pivot != column)
        {
            for (std::size_t index = 0; index < 8; ++index)
            {
                std::swap(augmented[pivot][index], augmented[column][index]);
            }
        }

        const double divisor = augmented[column][column];
        for (double& value : augmented[column])
        {
            value /= divisor;
        }

        for (std::size_t row = 0; row < 4; ++row)
        {
            if (row == column)
            {
                continue;
            }
            const double factor = augmented[row][column];
            for (std::size_t index = 0; index < 8; ++index)
            {
                augmented[row][index] -= factor * augmented[column][index];
            }
        }
    }

    Matrix4d result;
    for (std::size_t row = 0; row < 4; ++row)
    {
        for (std::size_t column = 0; column < 4; ++column)
        {
            result.at(row, column) = augmented[row][column + 4];
        }
    }
    return result;
}

Matrix4d Matrix4d::operator*(const Matrix4d& other) const
{
    Matrix4d result(Matrix4d::Storage{});
    for (std::size_t row = 0; row < 4; ++row)
    {
        for (std::size_t column = 0; column < 4; ++column)
        {
            for (std::size_t index = 0; index < 4; ++index)
            {
                result.at(row, column) += at(row, index) * other.at(index, column);
            }
        }
    }
    return result;
}

Matrix4d Matrix4d::toFloatCompatible() const
{
    Storage converted{};
    for (std::size_t index = 0; index < values_.size(); ++index)
    {
        converted[index] = static_cast<double>(static_cast<float>(values_[index]));
    }
    return Matrix4d(converted);
}

std::string Matrix4d::toString(int precision) const
{
    std::ostringstream output;
    output << std::fixed << std::setprecision(precision);
    for (std::size_t row = 0; row < 4; ++row)
    {
        for (std::size_t column = 0; column < 4; ++column)
        {
            if (column != 0)
            {
                output << ' ';
            }
            output << at(row, column);
        }
        output << '\n';
    }
    return output.str();
}

Matrix4d Matrix4d::fromFile(const std::filesystem::path& path)
{
    std::ifstream input(path);
    if (!input)
    {
        throw std::runtime_error("Cannot open matrix file: " + path.string());
    }
    Storage values{};
    for (double& value : values)
    {
        if (!(input >> value))
        {
            throw std::runtime_error("Matrix file must contain 16 numeric values");
        }
    }
    return Matrix4d(values);
}
} // namespace registration
