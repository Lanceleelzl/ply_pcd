// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/bidirectional_registration.hpp"

#include <DgmOctree.h>
#include <PointCloud.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <utility>

namespace registration
{
namespace
{
Matrix4d translation(const Point3d& value)
{
    Matrix4d result;
    for (std::size_t axis = 0; axis < 3; ++axis) result.at(axis, 3) = value[axis];
    return result;
}

template <typename Bounds>
double diagonal(const Bounds& bounds)
{
    double squared = 0.0;
    for (std::size_t axis = 0; axis < 3; ++axis)
    {
        const double extent = bounds.max[axis] - bounds.min[axis];
        squared += extent * extent;
    }
    return std::sqrt(squared);
}

Matrix4d localToWorldTransform(const Point3d& origin)
{
    return translation(origin);
}

Matrix4d worldToLocalTransform(const Point3d& origin)
{
    return translation(Point3d{-origin[0], -origin[1], -origin[2]});
}

bool insidePolygon(double x, double y, const std::vector<std::array<double, 2>>& polygon)
{
    bool inside = false;
    for (std::size_t i = 0, j = polygon.size() - 1; i < polygon.size(); j = i++)
    {
        const auto& a = polygon[i];
        const auto& b = polygon[j];
        if ((a[1] > y) != (b[1] > y)
            && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
}

PointCloud selectRegion(const PointCloud& cloud, const std::vector<std::array<double, 2>>& polygon,
                        const Matrix4d* initial)
{
    PointCloud selected;
    selected.points.reserve(cloud.points.size());
    for (const auto& point : cloud.points)
    {
        double x = point[0];
        double y = point[1];
        if (initial)
        {
            x = initial->at(0, 0) * point[0] + initial->at(0, 1) * point[1]
                + initial->at(0, 2) * point[2] + initial->at(0, 3);
            y = initial->at(1, 0) * point[0] + initial->at(1, 1) * point[1]
                + initial->at(1, 2) * point[2] + initial->at(1, 3);
        }
        if (insidePolygon(x, y, polygon)) selected.points.push_back(point);
    }
    return selected;
}

std::unique_ptr<CCCoreLib::PointCloud> sampledCloud(const PointCloud& source, const Matrix4d* transform)
{
    constexpr std::size_t sampleLimit = 50000;
    const std::size_t stride = std::max<std::size_t>(1, (source.points.size() + sampleLimit - 1) / sampleLimit);
    auto sampled = std::make_unique<CCCoreLib::PointCloud>();
    if (!sampled->reserve(static_cast<unsigned>((source.points.size() + stride - 1) / stride)))
        throw std::runtime_error("Cannot allocate ICP verification sample");
    for (std::size_t i = 0; i < source.points.size(); i += stride)
    {
        const auto& point = source.points[i];
        double values[3] = {point[0], point[1], point[2]};
        if (transform)
            for (std::size_t row = 0; row < 3; ++row)
                values[row] = transform->at(row, 0) * point[0] + transform->at(row, 1) * point[1]
                    + transform->at(row, 2) * point[2] + transform->at(row, 3);
        sampled->addPoint(CCVector3(static_cast<PointCoordinateType>(values[0]),
                                    static_cast<PointCoordinateType>(values[1]),
                                    static_cast<PointCoordinateType>(values[2])));
    }
    return sampled;
}

double nearestCoverage(CCCoreLib::PointCloud& query, CCCoreLib::PointCloud& reference, double distance)
{
    CCCoreLib::DgmOctree octree(&reference);
    if (octree.build() <= 0) throw std::runtime_error("Cannot build ICP verification index");
    std::size_t matched = 0;
    for (unsigned i = 0; i < query.size(); ++i)
    {
        CCCoreLib::DgmOctree::NearestNeighboursSearchStruct search;
        search.queryPoint = *query.getPoint(i);
        search.level = 8;
        bool inBounds = false;
        octree.getTheCellPosWhichIncludesThePoint(&search.queryPoint, search.cellPos, search.level, inBounds);
        search.alreadyVisitedNeighbourhoodSize = inBounds ? 0 : 1;
        octree.computeCellCenter(search.cellPos, search.level, search.cellCenter);
        search.maxSearchSquareDistd = distance * distance;
        const double squared = octree.findTheNearestNeighborStartingFromCell(search);
        if (squared >= 0.0 && squared <= distance * distance) ++matched;
    }
    return static_cast<double>(matched) / query.size();
}
} // namespace

MovingModel BidirectionalRegistration::recommendMovingModel(
    const ReferenceCloudReadResult& modelA,
    const ReferenceCloudReadResult& modelB)
{
    const double diagonalA = diagonal(modelA.worldBounds);
    const double diagonalB = diagonal(modelB.worldBounds);
    if (diagonalA > 0.0 && diagonalB > 0.0)
    {
        if (diagonalA < diagonalB * 0.95) return MovingModel::A;
        if (diagonalB < diagonalA * 0.95) return MovingModel::B;
    }
    return modelA.cloud.points.size() <= modelB.cloud.points.size() ? MovingModel::A : MovingModel::B;
}

BidirectionalRegistrationResult BidirectionalRegistration::registerModels(
    ReferenceCloudReadResult modelA,
    ReferenceCloudReadResult modelB,
    const BidirectionalRegistrationOptions& options) const
{
    BidirectionalRegistrationResult result;
    result.movingModel = options.movingModel == MovingModel::Auto
        ? recommendMovingModel(modelA, modelB)
        : options.movingModel;

    const auto& moving = result.movingModel == MovingModel::A ? modelA : modelB;
    const auto& fixed = result.movingModel == MovingModel::A ? modelB : modelA;
    PointCloud regionMoving;
    PointCloud regionFixed;
    const PointCloud* movingCloud = &moving.cloud;
    const PointCloud* fixedCloud = &fixed.cloud;
    if (!options.regionPolygon.empty())
    {
        const auto& initial = options.icp.initialMovingLocalToFixedLocal;
        regionMoving = selectRegion(moving.cloud, options.regionPolygon, &initial);
        regionFixed = selectRegion(fixed.cloud, options.regionPolygon, nullptr);
        if (regionMoving.points.size() < 30 || regionFixed.points.size() < 30)
            throw std::runtime_error("ICP region has too few points; enlarge or redraw the region");
        movingCloud = &regionMoving;
        fixedCloud = &regionFixed;
    }
    const auto icp = IcpRegistration().registerMovingToFixed(*movingCloud, *fixedCloud, options.icp);
    if (!options.regionPolygon.empty())
    {
        const double regionSize = std::min(diagonal(movingCloud->boundingBox()),
                                            diagonal(fixedCloud->boundingBox()));
        if (icp.finalPointCount < 30 || !std::isfinite(icp.finalRms)
            || (regionSize > 0.0 && icp.finalRms > 0.1 * regionSize
                && icp.finalPointCount < movingCloud->points.size() / 2))
            throw std::runtime_error("ICP region has insufficient reliable overlap; shrink or redraw the region");
    }
    result.initialMovingLocalToFixedLocal = icp.initialMovingLocalToFixedLocal;
    result.refinementMovingLocalToFixedLocal = icp.refinementMovingLocalToFixedLocal;
    result.movingLocalToFixedLocal = icp.movingLocalToFixedLocal;
    result.scale = icp.scale;
    result.finalRms = icp.finalRms;
    result.finalPointCount = icp.finalPointCount;
    result.regionMovingPointCount = movingCloud->points.size();
    result.regionFixedPointCount = fixedCloud->points.size();
    if (!options.regionPolygon.empty())
    {
        const double regionSize = std::min(diagonal(movingCloud->boundingBox()),
                                           diagonal(fixedCloud->boundingBox()));
        result.fullVerificationDistance = std::max(3.0 * result.finalRms, regionSize * 0.01);
        auto fullMoving = sampledCloud(moving.cloud, &result.movingLocalToFixedLocal);
        auto fullFixed = sampledCloud(fixed.cloud, nullptr);
        auto checkedRegionMoving = sampledCloud(*movingCloud, &result.movingLocalToFixedLocal);
        auto checkedRegionFixed = sampledCloud(*fixedCloud, nullptr);
        result.regionMovingCoverage = nearestCoverage(*checkedRegionMoving, *checkedRegionFixed,
                                                      result.fullVerificationDistance);
        result.regionFixedCoverage = nearestCoverage(*checkedRegionFixed, *checkedRegionMoving,
                                                     result.fullVerificationDistance);
        result.fullMovingCoverage = nearestCoverage(*fullMoving, *fullFixed, result.fullVerificationDistance);
        result.fullFixedCoverage = nearestCoverage(*fullFixed, *fullMoving, result.fullVerificationDistance);
    }

    if (result.movingModel == MovingModel::A)
    {
        result.aToB = localToWorldTransform(modelB.origin)
            * result.movingLocalToFixedLocal * worldToLocalTransform(modelA.origin);
        result.bToA = result.aToB.inverse();
    }
    else
    {
        result.bToA = localToWorldTransform(modelA.origin)
            * result.movingLocalToFixedLocal * worldToLocalTransform(modelB.origin);
        result.aToB = result.bToA.inverse();
    }
    result.modelA = std::move(modelA);
    result.modelB = std::move(modelB);
    return result;
}
} // namespace registration
