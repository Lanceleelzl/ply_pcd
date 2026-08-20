// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"

#include <PointCloud.h>
#include <CloudSamplingTools.h>
#include <RegistrationTools.h>

#include <memory>
#include <limits>
#include <stdexcept>
#include <string>

namespace registration
{
namespace
{
std::unique_ptr<CCCoreLib::PointCloud> toCloudCompareCloud(const PointCloud& source)
{
    auto target = std::make_unique<CCCoreLib::PointCloud>();
    if (source.points.size() > static_cast<std::size_t>(std::numeric_limits<unsigned>::max()))
        throw std::runtime_error("Point cloud exceeds CCCoreLib point count limit");
    if (!target->reserve(static_cast<unsigned>(source.points.size())))
        throw std::runtime_error("Cannot allocate CCCoreLib point cloud");
    for (const auto& point : source.points)
        target->addPoint(CCVector3(point[0], point[1], point[2]));
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

    auto dataCloud = toCloudCompareCloud(pcd);
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
    result.pcdToPly = status == CCCoreLib::ICPRegistrationTools::ICP_APPLY_TRANSFO
        ? toMatrix(transform)
        : Matrix4d();
    result.plyToPcd = result.pcdToPly.inverse();
    result.scale = transform.s;
    result.finalRms = finalRms;
    result.finalPointCount = finalPointCount;
    return result;
}
} // namespace registration
