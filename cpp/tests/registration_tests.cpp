// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"
#include "registration/matrix.hpp"
#include "registration/pcd_reader.hpp"
#include "registration/ply_reader.hpp"

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>

namespace
{
void require(bool condition, const std::string& message)
{
    if (!condition) throw std::runtime_error(message);
}

void requireNear(double actual, double expected, double tolerance, const std::string& message)
{
    if (std::abs(actual - expected) > tolerance)
    {
        throw std::runtime_error(message + ": actual=" + std::to_string(actual) +
                                 ", expected=" + std::to_string(expected));
    }
}

std::filesystem::path sourcePath(const std::string& relative)
{
    return std::filesystem::path(REGISTRATION_SOURCE_DIR) / relative;
}

void testGoldenMatrixInverse()
{
    const auto pcdToPly = registration::Matrix4d::fromFile(
        sourcePath("tests/regression/cloudcompare_pcd_to_ply_matrix.txt"));
    const auto expected = registration::Matrix4d::fromFile(
        sourcePath("tests/regression/cloudcompare_ply_to_pcd_matrix.txt"));
    const auto actual = pcdToPly.inverse();
    for (std::size_t index = 0; index < 16; ++index)
        requireNear(actual.values()[index], expected.values()[index], 5.0e-12, "Golden inverse mismatch");

    const auto identity = pcdToPly * actual;
    for (std::size_t row = 0; row < 4; ++row)
        for (std::size_t column = 0; column < 4; ++column)
            requireNear(identity.at(row, column), row == column ? 1.0 : 0.0, 1.0e-12,
                        "Matrix round trip mismatch");
}

void testRealPcd()
{
    const auto result = registration::PcdReader().read(sourcePath("source/pcd/GlobalMap.pcd"));
    require(result.declaredPointCount == 149317, "Unexpected PCD declared point count");
    require(result.cloud.points.size() == 149317, "Unexpected PCD valid point count");
    require(result.invalidPointCount == 0, "Unexpected invalid PCD points");
    const auto box = result.cloud.boundingBox();
    requireNear(box.min[0], -5.5668, 1.0e-3, "PCD min X mismatch");
    requireNear(box.max[1], 17.6904, 1.0e-3, "PCD max Y mismatch");
}

void testRealPly()
{
    const auto result = registration::PlyReader().read(sourcePath("source/ply/point_cloud.ply"));
    require(result.declaredVertexCount == 3777901, "Unexpected PLY declared vertex count");
    require(result.cloud.points.size() == 3777901, "Unexpected PLY valid point count");
    require(result.invalidPointCount == 0, "Unexpected invalid PLY points");
    const auto box = result.cloud.boundingBox();
    requireNear(box.min[0], -32.2649, 1.0e-3, "PLY min X mismatch");
    requireNear(box.max[1], 44.6180, 1.0e-3, "PLY max Y mismatch");
}

void testRealIcpAgainstCloudCompare()
{
    const auto ply = registration::PlyReader().read(sourcePath("source/ply/point_cloud.ply"));
    const auto pcd = registration::PcdReader().read(sourcePath("source/pcd/GlobalMap.pcd"));
    registration::IcpOptions options;
    options.randomSeed = 42;
    const auto result = registration::IcpRegistration().registerPcdToPly(pcd.cloud, ply.cloud, options);
    const auto golden = registration::Matrix4d::fromFile(
        sourcePath("tests/regression/cloudcompare_pcd_to_ply_matrix.txt"));

    double translationSquared = 0.0;
    for (std::size_t axis = 0; axis < 3; ++axis)
    {
        const double delta = result.pcdToPly.at(axis, 3) - golden.at(axis, 3);
        translationSquared += delta * delta;
    }
    const double translationDifference = std::sqrt(translationSquared);

    double relativeTrace = 0.0;
    for (std::size_t row = 0; row < 3; ++row)
        for (std::size_t column = 0; column < 3; ++column)
            relativeTrace += result.pcdToPly.at(row, column) * golden.at(row, column);
    const double cosine = std::clamp((relativeTrace - 1.0) / 2.0, -1.0, 1.0);
    constexpr double radiansToDegrees = 57.2957795130823208768;
    const double rotationDifferenceDegrees = std::acos(cosine) * radiansToDegrees;

    require(translationDifference < 0.03, "ICP translation differs from CloudCompare by at least 3 cm");
    require(rotationDifferenceDegrees < 0.3, "ICP rotation differs from CloudCompare by at least 0.3 degrees");
    require(result.finalPointCount == 50000, "Unexpected ICP final point count");
    require(result.finalRms > 0.0 && result.finalRms < 0.30, "Unexpected ICP final RMS");

    const auto repeated = registration::IcpRegistration().registerPcdToPly(pcd.cloud, ply.cloud, options);
    for (std::size_t index = 0; index < 16; ++index)
        requireNear(repeated.pcdToPly.values()[index], result.pcdToPly.values()[index], 1.0e-12,
                    "Fixed-seed ICP is not deterministic");
}
} // namespace

int main()
{
    try
    {
        testGoldenMatrixInverse();
        testRealPcd();
        testRealPly();
        testRealIcpAgainstCloudCompare();
        std::cout << "All registration tests passed\n";
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << "Test failure: " << error.what() << '\n';
        return 1;
    }
}
