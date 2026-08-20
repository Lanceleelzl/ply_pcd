// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"

#include <PointCloud.h>
#include <CloudSamplingTools.h>
#include <RegistrationTools.h>

#include <cmath>
#include <memory>
#include <limits>
#include <stdexcept>
#include <string>

namespace registration
{
namespace
{
void validateRigidTransform(const Matrix4d& matrix)
{
    constexpr double tolerance = 1.0e-5;
    for (const double value : matrix.values())
    {
        if (!std::isfinite(value)) throw std::runtime_error("Initial matrix contains a non-finite value");
    }
    if (std::abs(matrix.at(3, 0)) > tolerance || std::abs(matrix.at(3, 1)) > tolerance
        || std::abs(matrix.at(3, 2)) > tolerance || std::abs(matrix.at(3, 3) - 1.0) > tolerance)
        throw std::runtime_error("Initial matrix must have affine last row [0 0 0 1]");
    for (std::size_t column = 0; column < 3; ++column)
    {
        double lengthSquared = 0.0;
        for (std::size_t row = 0; row < 3; ++row)
            lengthSquared += matrix.at(row, column) * matrix.at(row, column);
        if (std::abs(lengthSquared - 1.0) > tolerance)
            throw std::runtime_error("Initial matrix rotation must not contain scale");
    }
    for (std::size_t left = 0; left < 3; ++left)
    {
        for (std::size_t right = left + 1; right < 3; ++right)
        {
            double dot = 0.0;
            for (std::size_t row = 0; row < 3; ++row)
                dot += matrix.at(row, left) * matrix.at(row, right);
            if (std::abs(dot) > tolerance)
                throw std::runtime_error("Initial matrix rotation must be orthogonal");
        }
    }
    const double determinant =
        matrix.at(0, 0) * (matrix.at(1, 1) * matrix.at(2, 2) - matrix.at(1, 2) * matrix.at(2, 1))
        - matrix.at(0, 1) * (matrix.at(1, 0) * matrix.at(2, 2) - matrix.at(1, 2) * matrix.at(2, 0))
        + matrix.at(0, 2) * (matrix.at(1, 0) * matrix.at(2, 1) - matrix.at(1, 1) * matrix.at(2, 0));
    if (std::abs(determinant - 1.0) > tolerance)
        throw std::runtime_error("Initial matrix rotation determinant must be +1");
}

std::unique_ptr<CCCoreLib::PointCloud> toCloudCompareCloud(const PointCloud& source,
                                                           const Matrix4d* transform = nullptr)
{
    auto target = std::make_unique<CCCoreLib::PointCloud>();
    if (source.points.size() > static_cast<std::size_t>(std::numeric_limits<unsigned>::max()))
        throw std::runtime_error("Point cloud exceeds CCCoreLib point count limit");
    if (!target->reserve(static_cast<unsigned>(source.points.size())))
        throw std::runtime_error("Cannot allocate CCCoreLib point cloud");
    for (const auto& point : source.points)
    {
        if (transform == nullptr)
        {
            target->addPoint(CCVector3(point[0], point[1], point[2]));
            continue;
        }
        const double x = transform->at(0, 0) * point[0] + transform->at(0, 1) * point[1]
            + transform->at(0, 2) * point[2] + transform->at(0, 3);
        const double y = transform->at(1, 0) * point[0] + transform->at(1, 1) * point[1]
            + transform->at(1, 2) * point[2] + transform->at(1, 3);
        const double z = transform->at(2, 0) * point[0] + transform->at(2, 1) * point[1]
            + transform->at(2, 2) * point[2] + transform->at(2, 3);
        target->addPoint(CCVector3(static_cast<PointCoordinateType>(x),
                                   static_cast<PointCoordinateType>(y),
                                   static_cast<PointCoordinateType>(z)));
    }
    return target;
}

Matrix4d toMatrix(const CCCoreLib::PointProjectionTools::Transformation& transform)
{
    Matrix4d matrix;
    for (std::size_t row = 0; row < 3; ++row)
    {
        for (std::size_t column = 0; column < 3; ++column)
            matrix.at(row, column) = transform.s * transform.R.getValue(static_cast<unsigned>(row), static_cast<unsigned>(column));
    }
    matrix.at(0, 3) = transform.T.x;
    matrix.at(1, 3) = transform.T.y;
    matrix.at(2, 3) = transform.T.z;
    return matrix;
}
} // namespace

IcpResult IcpRegistration::registerPcdToPly(const PointCloud& pcd,
                                            const PointCloud& ply,
                                            const IcpOptions& options) const
{
    if (pcd.points.size() < 3 || ply.points.size() < 3)
        throw std::runtime_error("ICP requires at least three points in each cloud");
    if (!(options.finalOverlapRatio > 0.0 && options.finalOverlapRatio <= 1.0))
        throw std::runtime_error("ICP overlap ratio must be in (0, 1]");
    validateRigidTransform(options.initialPcdToPly);

    auto dataCloud = toCloudCompareCloud(pcd, &options.initialPcdToPly);
    auto modelCloud = toCloudCompareCloud(ply);

    CCCoreLib::ICPRegistrationTools::Parameters parameters;
    parameters.convType = options.maxIterations == 0
        ? CCCoreLib::ICPRegistrationTools::MAX_ERROR_CONVERGENCE
        : CCCoreLib::ICPRegistrationTools::MAX_ITER_CONVERGENCE;
    parameters.minRMSDecrease = options.minRmsDecrease;
    parameters.nbMaxIterations = options.maxIterations;
    parameters.adjustScale = options.adjustScale;
    parameters.filterOutFarthestPoints = options.filterOutFarthestPoints;
    parameters.samplingLimit = options.samplingLimit;
    parameters.finalOverlapRatio = options.finalOverlapRatio;
    parameters.maxThreadCount = options.maxThreadCount;
    parameters.normalsMatching = CCCoreLib::ICPRegistrationTools::NO_NORMAL;
    CCCoreLib::CloudSamplingTools::SetRandomSeed(options.randomSeed);

    CCCoreLib::PointProjectionTools::Transformation transform;
    double finalRms = -1.0;
    unsigned finalPointCount = 0;
    const auto status = CCCoreLib::ICPRegistrationTools::Register(
        modelCloud.get(), nullptr, dataCloud.get(), parameters,
        transform, finalRms, finalPointCount, nullptr);
    if (status >= CCCoreLib::ICPRegistrationTools::ICP_ERROR)
        throw std::runtime_error("CloudCompare ICP failed with status " + std::to_string(static_cast<int>(status)));

    IcpResult result;
    result.initialPcdToPly = options.initialPcdToPly;
    result.refinementPcdToPly = status == CCCoreLib::ICPRegistrationTools::ICP_APPLY_TRANSFO
        ? toMatrix(transform)
        : Matrix4d();
    result.pcdToPly = result.refinementPcdToPly * result.initialPcdToPly;
    result.plyToPcd = result.pcdToPly.inverse();
    result.scale = transform.s;
    result.finalRms = finalRms;
    result.finalPointCount = finalPointCount;
    return result;
}
} // namespace registration
