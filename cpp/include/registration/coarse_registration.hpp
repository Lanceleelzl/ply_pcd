// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/matrix.hpp"
#include "registration/point_cloud.hpp"

#include <cstdint>
#include <string>
#include <vector>

namespace registration
{
struct CoarseRegistrationOptions
{
    double delta = 0.01;
    double beta = 0.005;
    double overlap = 0.7;
    unsigned baseCount = 200;
    unsigned baseTries = 100;
    unsigned maxCandidates = 500;
    unsigned sampleLimit = 1000;
    std::uint32_t randomSeed = 42;
};

struct CoarseRegistrationCandidate
{
    Matrix4d movingLocalToFixedLocal;
    std::uint32_t randomSeed = 42;
    double overlap = 0.7;
    double movingCoverage = 0.0;
    double fixedCoverage = 0.0;
    double inlierRms = -1.0;
    double score = 0.0;
    unsigned validationPointCount = 0;
};

struct CoarseRegistrationSearchResult
{
    std::vector<CoarseRegistrationCandidate> candidates;
    std::string risk = "low_confidence";
};

class CoarseRegistration
{
public:
    [[nodiscard]] CoarseRegistrationCandidate findCandidate(
        const PointCloud& moving,
        const PointCloud& fixed,
        const CoarseRegistrationOptions& options = {}) const;
    [[nodiscard]] CoarseRegistrationSearchResult findCandidates(
        const PointCloud& moving,
        const PointCloud& fixed,
        const std::vector<double>& overlaps,
        const std::vector<std::uint32_t>& randomSeeds,
        const CoarseRegistrationOptions& options = {}) const;
};
} // namespace registration
