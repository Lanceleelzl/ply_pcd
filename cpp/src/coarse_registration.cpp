// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/coarse_registration.hpp"

#include <PointCloud.h>
#include <RegistrationTools.h>

#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

namespace registration
{
namespace
{
std::unique_ptr<CCCoreLib::PointCloud> toCloudCompareCloud(const PointCloud& source)
{
    if (source.points.size() > static_cast<std::size_t>(std::numeric_limits<unsigned>::max()))
        throw std::runtime_error("Point cloud exceeds CCCoreLib point count limit");
    auto target = std::make_unique<CCCoreLib::PointCloud>();
    if (!target->reserve(static_cast<unsigned>(source.points.size())))
        throw std::runtime_error("Cannot allocate CCCoreLib point cloud");
    for (const auto& point : source.points)
        target->addPoint(CCVector3(point[0], point[1], point[2]));
    return target;
}

PointCloud boundedSample(const PointCloud& source, unsigned limit)
{
    if (source.points.size() <= limit) return source;
    PointCloud sampled;
    sampled.points.reserve(limit);
    for (std::size_t index = 0; index < limit; ++index)
    {
        const std::size_t sourceIndex = index * source.points.size() / limit;
        sampled.points.push_back(source.points[sourceIndex]);
    }
    return sampled;
}

Matrix4d toRigidMatrix(const CCCoreLib::PointProjectionTools::Transformation& transform)
{
    if (!transform.R.isValid() || std::abs(static_cast<double>(transform.s) - 1.0) > 1.0e-5)
        throw std::runtime_error("4PCS did not produce a rigid transformation");
    Matrix4d matrix;
    for (std::size_t row = 0; row < 3; ++row)
        for (std::size_t column = 0; column < 3; ++column)
            matrix.at(row, column) = transform.R.getValue(static_cast<unsigned>(row), static_cast<unsigned>(column));
    matrix.at(0, 3) = transform.T.x;
    matrix.at(1, 3) = transform.T.y;
    matrix.at(2, 3) = transform.T.z;
    return matrix;
}

Point3f transformPoint(const Matrix4d& matrix, const Point3f& point)
{
    Point3f transformed{};
    for (std::size_t row = 0; row < 3; ++row)
    {
        double value = matrix.at(row, 3);
        for (std::size_t column = 0; column < 3; ++column)
            value += matrix.at(row, column) * point[column];
        transformed[row] = static_cast<float>(value);
    }
    return transformed;
}

struct DirectionMetrics
{
    unsigned inliers = 0;
    double squaredDistance = 0.0;
};

DirectionMetrics evaluateDirection(const PointCloud& source, const PointCloud& target,
                                   const Matrix4d& sourceToTarget, double threshold)
{
    DirectionMetrics metrics;
    const double thresholdSquared = threshold * threshold;
    for (const auto& point : source.points)
    {
        const auto transformed = transformPoint(sourceToTarget, point);
        double nearestSquared = std::numeric_limits<double>::infinity();
        for (const auto& candidate : target.points)
        {
            double squared = 0.0;
            for (std::size_t axis = 0; axis < 3; ++axis)
            {
                const double difference = transformed[axis] - candidate[axis];
                squared += difference * difference;
            }
            nearestSquared = std::min(nearestSquared, squared);
        }
        if (nearestSquared <= thresholdSquared)
        {
            ++metrics.inliers;
            metrics.squaredDistance += nearestSquared;
        }
    }
    return metrics;
}

double translationDistance(const Matrix4d& left, const Matrix4d& right)
{
    double squared = 0.0;
    for (std::size_t axis = 0; axis < 3; ++axis)
    {
        const double difference = left.at(axis, 3) - right.at(axis, 3);
        squared += difference * difference;
    }
    return std::sqrt(squared);
}

double rotationDistanceDegrees(const Matrix4d& left, const Matrix4d& right)
{
    double trace = 0.0;
    for (std::size_t row = 0; row < 3; ++row)
        for (std::size_t column = 0; column < 3; ++column)
            trace += left.at(row, column) * right.at(row, column);
    const double cosine = std::clamp((trace - 1.0) * 0.5, -1.0, 1.0);
    return std::acos(cosine) * 57.2957795130823208768;
}
} // namespace

CoarseRegistrationCandidate CoarseRegistration::findCandidate(
    const PointCloud& moving,
    const PointCloud& fixed,
    const CoarseRegistrationOptions& options) const
{
    if (moving.points.size() < 4 || fixed.points.size() < 4)
        throw std::runtime_error("4PCS requires at least four points in each cloud");
    if (!(options.delta > 0.0) || !(options.beta > 0.0))
        throw std::runtime_error("4PCS delta and beta must be positive");
    if (!(options.overlap > 0.0 && options.overlap <= 1.0))
        throw std::runtime_error("4PCS overlap must be in (0, 1]");
    if (options.baseCount == 0 || options.baseTries == 0 || options.randomSeed == 0)
        throw std::runtime_error("4PCS counts and random seed must be non-zero");
    if (options.sampleLimit < 4)
        throw std::runtime_error("4PCS sample limit must be at least four");

    const auto movingSample = boundedSample(moving, options.sampleLimit);
    const auto fixedSample = boundedSample(fixed, options.sampleLimit);
    auto movingCloud = toCloudCompareCloud(movingSample);
    auto fixedCloud = toCloudCompareCloud(fixedSample);
    CCCoreLib::PointProjectionTools::Transformation transform;
    const bool found = CCCoreLib::FPCSRegistrationTools::RegisterClouds(
        fixedCloud.get(), movingCloud.get(), transform,
        static_cast<ScalarType>(options.delta), static_cast<ScalarType>(options.beta),
        static_cast<PointCoordinateType>(options.overlap), options.baseCount, options.baseTries,
        nullptr, options.maxCandidates, options.randomSeed);
    if (!found || !transform.R.isValid())
        throw std::runtime_error("4PCS could not find a coarse registration candidate");
    CoarseRegistrationCandidate candidate;
    candidate.movingLocalToFixedLocal = toRigidMatrix(transform);
    candidate.randomSeed = options.randomSeed;
    candidate.overlap = options.overlap;
    const auto movingMetrics = evaluateDirection(
        movingSample, fixedSample, candidate.movingLocalToFixedLocal, options.delta);
    const auto fixedMetrics = evaluateDirection(
        fixedSample, movingSample, candidate.movingLocalToFixedLocal.inverse(), options.delta);
    candidate.movingCoverage = static_cast<double>(movingMetrics.inliers) / movingSample.points.size();
    candidate.fixedCoverage = static_cast<double>(fixedMetrics.inliers) / fixedSample.points.size();
    candidate.validationPointCount = movingMetrics.inliers + fixedMetrics.inliers;
    if (candidate.validationPointCount > 0)
    {
        candidate.inlierRms = std::sqrt(
            (movingMetrics.squaredDistance + fixedMetrics.squaredDistance) / candidate.validationPointCount);
        const double coverage = std::min(candidate.movingCoverage, candidate.fixedCoverage);
        candidate.score = coverage / (1.0 + candidate.inlierRms / options.delta);
    }
    return candidate;
}


CoarseRegistrationSearchResult CoarseRegistration::findCandidates(
    const PointCloud& moving,
    const PointCloud& fixed,
    const std::vector<double>& overlaps,
    const std::vector<std::uint32_t>& randomSeeds,
    const CoarseRegistrationOptions& options) const
{
    if (overlaps.empty() || randomSeeds.empty())
        throw std::runtime_error("4PCS candidate search requires overlaps and random seeds");
    std::vector<CoarseRegistrationCandidate> found;
    for (const double overlap : overlaps)
    {
        for (const std::uint32_t seed : randomSeeds)
        {
            auto candidateOptions = options;
            candidateOptions.overlap = overlap;
            candidateOptions.randomSeed = seed;
            try
            {
                found.push_back(findCandidate(moving, fixed, candidateOptions));
            }
            catch (const std::runtime_error&)
            {
                // A failed search combination is not a failed multi-candidate task.
            }
        }
    }
    if (found.empty())
        throw std::runtime_error("4PCS could not find any coarse registration candidate");
    std::sort(found.begin(), found.end(), [](const auto& left, const auto& right) {
        return left.score > right.score;
    });

    CoarseRegistrationSearchResult result;
    for (const auto& candidate : found)
    {
        const bool duplicate = std::any_of(result.candidates.begin(), result.candidates.end(), [&](const auto& kept) {
            return translationDistance(candidate.movingLocalToFixedLocal, kept.movingLocalToFixedLocal) <= options.delta
                && rotationDistanceDegrees(candidate.movingLocalToFixedLocal, kept.movingLocalToFixedLocal) <= 0.25;
        });
        if (!duplicate) result.candidates.push_back(candidate);
    }
    const auto& best = result.candidates.front();
    if (best.score >= 0.15 && std::min(best.movingCoverage, best.fixedCoverage) >= 0.15)
        result.risk = "none";
    if (result.candidates.size() > 1
        && result.candidates[1].score >= best.score * 0.95)
        result.risk = "ambiguous";
    return result;
}
} // namespace registration
