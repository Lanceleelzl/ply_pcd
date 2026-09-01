// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/bidirectional_registration.hpp"

#include <cmath>
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

double diagonal(const BoundingBox3d& bounds)
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
    const auto icp = IcpRegistration().registerMovingToFixed(moving.cloud, fixed.cloud, options.icp);
    result.initialMovingLocalToFixedLocal = icp.initialMovingLocalToFixedLocal;
    result.refinementMovingLocalToFixedLocal = icp.refinementMovingLocalToFixedLocal;
    result.movingLocalToFixedLocal = icp.movingLocalToFixedLocal;
    result.scale = icp.scale;
    result.finalRms = icp.finalRms;
    result.finalPointCount = icp.finalPointCount;

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
