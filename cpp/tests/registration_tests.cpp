// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"
#include "registration/bidirectional_registration.hpp"
#include "registration/gaussian_preview.hpp"
#include "registration/matrix.hpp"
#include "registration/pcd_reader.hpp"
#include "registration/ply_reader.hpp"
#include "registration/point_cloud_preview.hpp"
#include "registration/reference_cloud_reader.hpp"

#include <laszip_api.h>

#include <algorithm>
#include <cmath>
#include <filesystem>
#include <fstream>
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

void writeLaszipFixture(const std::filesystem::path& path, bool compressed)
{
    const double points[][3] = {
        {630499.95, 4834749.17, 62.15},
        {630499.83, 4834748.88, 62.68},
        {630499.54, 4834749.66, 62.66},
        {630498.56, 4834749.41, 61.33},
        {630499.35, 4834748.73, 63.68},
    };
    laszip_POINTER writer = nullptr;
    require(laszip_create(&writer) == 0, "Cannot create LASzip test writer");
    laszip_header_struct* header = nullptr;
    require(laszip_get_header_pointer(writer, &header) == 0, "Cannot get LASzip test header");
    header->version_major = 1;
    header->version_minor = 2;
    header->point_data_format = 0;
    header->point_data_record_length = 20;
    header->number_of_point_records = 5;
    header->number_of_points_by_return[0] = 5;
    header->x_scale_factor = header->y_scale_factor = header->z_scale_factor = 0.001;
    header->x_offset = 630499.0;
    header->y_offset = 4834749.0;
    header->z_offset = 62.0;
    header->min_x = 630498.56; header->max_x = 630499.95;
    header->min_y = 4834748.73; header->max_y = 4834749.66;
    header->min_z = 61.33; header->max_z = 63.68;
    const auto filename = path.string();
    require(laszip_open_writer(writer, filename.c_str(), compressed ? 1 : 0) == 0,
            "Cannot open LASzip test output");
    for (const auto& point : points)
    {
        require(laszip_set_coordinates(writer, point) == 0, "Cannot set LASzip test coordinate");
        require(laszip_write_point(writer) == 0, "Cannot write LASzip test point");
    }
    require(laszip_close_writer(writer) == 0, "Cannot close LASzip test writer");
    require(laszip_destroy(writer) == 0, "Cannot destroy LASzip test writer");
}

void testLasAndLazPrecision()
{
    const auto outputDirectory = sourcePath("runtime/test-output");
    std::filesystem::create_directories(outputDirectory);
    const auto lasPath = outputDirectory / "large-coordinate-fixture.las";
    const auto lazPath = outputDirectory / "large-coordinate-fixture.laz";
    writeLaszipFixture(lasPath, false);
    writeLaszipFixture(lazPath, true);
    const auto las = registration::ReferenceCloudReader().read(lasPath);
    const auto laz = registration::ReferenceCloudReader().read(lazPath);
    require(las.format == "las" && laz.format == "laz", "LAS/LAZ format detection mismatch");
    require(las.cloud.points.size() == 5 && laz.cloud.points.size() == 5, "LAS/LAZ point count mismatch");
    for (std::size_t axis = 0; axis < 3; ++axis)
    {
        requireNear(las.origin[axis], laz.origin[axis], 0.0, "LAS/LAZ origin mismatch");
        requireNear(las.worldBounds.min[axis], laz.worldBounds.min[axis], 0.0, "LAS/LAZ min bounds mismatch");
        requireNear(las.worldBounds.max[axis], laz.worldBounds.max[axis], 0.0, "LAS/LAZ max bounds mismatch");
    }
    for (std::size_t index = 0; index < las.cloud.points.size(); ++index)
        for (std::size_t axis = 0; axis < 3; ++axis)
            requireNear(las.cloud.points[index][axis], laz.cloud.points[index][axis], 0.0,
                        "LAS/LAZ localized coordinate mismatch");
    requireNear(las.origin[0], 630499.255, 1.0e-9, "LAS origin X mismatch");
    requireNear(las.origin[1], 4834749.195, 1.0e-9, "LAS origin Y mismatch");
    requireNear(las.origin[2], 62.505, 1.0e-9, "LAS origin Z mismatch");
    requireNear(static_cast<double>(las.cloud.points[0][0]) + las.origin[0], 630499.95, 1.0e-7,
                "LAS localized X lost precision");
}

void testReferenceOriginMatrixComposition()
{
    registration::Matrix4d localToPly;
    localToPly.at(0, 3) = 1.25;
    localToPly.at(1, 3) = -2.5;
    localToPly.at(2, 3) = 0.75;
    registration::Matrix4d worldToLocal;
    worldToLocal.at(0, 3) = -630499.255;
    worldToLocal.at(1, 3) = -4834749.195;
    worldToLocal.at(2, 3) = -62.505;
    const auto worldToPly = localToPly * worldToLocal;
    const auto plyToWorld = worldToPly.inverse();
    const auto identity = worldToPly * plyToWorld;
    for (std::size_t row = 0; row < 4; ++row)
        for (std::size_t column = 0; column < 4; ++column)
            requireNear(identity.at(row, column), row == column ? 1.0 : 0.0, 1.0e-9,
                        "Reference origin matrix round trip mismatch");
    requireNear(plyToWorld.at(0, 3), 630498.005, 1.0e-9, "PLY-to-world X composition mismatch");
    requireNear(plyToWorld.at(1, 3), 4834751.695, 1.0e-9, "PLY-to-world Y composition mismatch");
    requireNear(plyToWorld.at(2, 3), 61.755, 1.0e-9, "PLY-to-world Z composition mismatch");
}

registration::ReferenceCloudReadResult syntheticModel(const registration::Point3d& origin)
{
    registration::ReferenceCloudReadResult result;
    result.format = "ply";
    result.origin = origin;
    result.cloud.points = {
        {0.0F, 0.0F, 0.0F}, {1.0F, 0.0F, 0.0F}, {0.0F, 1.0F, 0.0F},
        {0.0F, 0.0F, 1.0F}, {1.0F, 1.0F, 1.0F}};
    result.declaredPointCount = result.cloud.points.size();
    result.worldBounds.min = origin;
    result.worldBounds.max = {origin[0] + 1.0, origin[1] + 1.0, origin[2] + 1.0};
    return result;
}

void testBidirectionalRegistrationRoles()
{
    for (const auto moving : {registration::MovingModel::A, registration::MovingModel::B})
    {
        registration::BidirectionalRegistrationOptions options;
        options.movingModel = moving;
        options.icp.samplingLimit = 100;
        options.icp.randomSeed = 42;
        const auto result = registration::BidirectionalRegistration().registerModels(
            syntheticModel({1000.0, 2000.0, 3000.0}),
            syntheticModel({1010.0, 2020.0, 3030.0}), options);
        requireNear(result.aToB.at(0, 3), 10.0, 1.0e-9, "A-to-B X origin composition mismatch");
        requireNear(result.aToB.at(1, 3), 20.0, 1.0e-9, "A-to-B Y origin composition mismatch");
        requireNear(result.aToB.at(2, 3), 30.0, 1.0e-9, "A-to-B Z origin composition mismatch");
        const auto identity = result.aToB * result.bToA;
        for (std::size_t index = 0; index < 16; ++index)
            requireNear(identity.values()[index], index % 5 == 0 ? 1.0 : 0.0, 1.0e-9,
                        "Bidirectional result matrices are not inverse");
    }
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

void testPreviewWriters()
{
    registration::PointCloud cloud;
    for (int x = 0; x < 20; ++x)
        for (int y = 0; y < 20; ++y)
            for (int z = 0; z < 3; ++z)
                cloud.points.push_back({static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)});
    const auto previewPath = std::filesystem::temp_directory_path() / "ply-pcd-registration-preview.bin";
    const auto gaussianPath = std::filesystem::temp_directory_path() / "ply-pcd-registration-gaussian.ply";
    const auto result = registration::PointCloudPreview().write(cloud, 100, previewPath);
    require(result.previewPointCount <= 100 && result.previewPointCount >= 50,
            "Preview sampler did not approach its point limit");
    std::ifstream preview(previewPath, std::ios::binary);
    char magic[8]{};
    std::uint32_t count = 0;
    preview.read(magic, sizeof(magic));
    preview.read(reinterpret_cast<char*>(&count), sizeof(count));
    require(std::string(magic, sizeof(magic)) == "PCPV0001", "Preview magic mismatch");
    require(count == result.previewPointCount, "Preview header count mismatch");
    preview.close();

    registration::GaussianPreview().write(
        sourcePath("source/ply/point_cloud.ply"), {0, 1, 2}, gaussianPath);
    std::ifstream gaussian(gaussianPath, std::ios::binary);
    std::string line;
    bool foundVertexCount = false;
    while (std::getline(gaussian, line))
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line == "element vertex 3") foundVertexCount = true;
        if (line == "end_header") break;
    }
    require(foundVertexCount, "Gaussian preview vertex count was not replaced");
    gaussian.close();
    std::filesystem::remove(previewPath);
    std::filesystem::remove(gaussianPath);
}

void testInitialMatrixValidation()
{
    registration::PointCloud cloud;
    cloud.points = {{0.0F, 0.0F, 0.0F}, {1.0F, 0.0F, 0.0F}, {0.0F, 1.0F, 0.0F}};
    registration::IcpOptions options;
    options.initialPcdToPly.at(0, 0) = 2.0;
    bool rejected = false;
    try
    {
        static_cast<void>(registration::IcpRegistration().registerPcdToPly(cloud, cloud, options));
    }
    catch (const std::runtime_error&)
    {
        rejected = true;
    }
    require(rejected, "ICP accepted an initial matrix containing scale");
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
    for (std::size_t index = 0; index < 16; ++index)
    {
        const double identityValue = index % 5 == 0 ? 1.0 : 0.0;
        requireNear(result.initialPcdToPly.values()[index], identityValue, 0.0,
                    "Default initial matrix is not identity");
        requireNear(result.refinementPcdToPly.values()[index], result.pcdToPly.values()[index], 1.0e-12,
                    "Identity initial matrix changed final ICP transform");
    }

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
        testLasAndLazPrecision();
        testReferenceOriginMatrixComposition();
        testBidirectionalRegistrationRoles();
        testRealPly();
        testPreviewWriters();
        testInitialMatrixValidation();
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
