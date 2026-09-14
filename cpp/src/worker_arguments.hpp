// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/bidirectional_registration.hpp"
#include "registration/coarse_registration.hpp"
#include "registration/icp_registration.hpp"
#include "registration/matrix.hpp"

#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace registration::worker
{
struct PreviewArguments
{
    std::filesystem::path ply;
    std::filesystem::path reference;
    std::filesystem::path outputDirectory;
    std::size_t plyLimit = 300000;
    std::size_t pcdLimit = 300000;
};

struct RegisterArguments
{
    std::filesystem::path ply;
    std::filesystem::path reference;
    std::filesystem::path outputDirectory;
    IcpOptions options;
    std::string precisionMode = "recommended";
    unsigned highAccuracySamplingLimit = 500000;
    unsigned stabilityRuns = 3;
};

struct ModelRegisterArguments
{
    std::filesystem::path modelA;
    std::filesystem::path modelB;
    std::filesystem::path outputDirectory;
    BidirectionalRegistrationOptions options;
    std::string outputDirection = "a_to_b";
    bool progressJsonLines = false;
    std::optional<Matrix4d> modelAToBusiness;
    std::optional<Matrix4d> modelBToBusiness;
};

struct CoarseRegisterArguments
{
    std::filesystem::path modelA;
    std::filesystem::path modelB;
    std::filesystem::path outputDirectory;
    MovingModel movingModel = MovingModel::A;
    CoarseRegistrationOptions options;
    std::vector<double> overlaps{0.5, 0.7, 0.9};
    std::vector<std::uint32_t> randomSeeds{42, 43};
    std::optional<Matrix4d> modelAToBusiness;
    std::optional<Matrix4d> modelBToBusiness;
};

struct ModelPreviewArguments
{
    std::filesystem::path modelA;
    std::filesystem::path modelB;
    std::filesystem::path outputDirectory;
    std::size_t modelALimit = 300000;
    std::size_t modelBLimit = 300000;
};

void printUsage();
PreviewArguments parsePreviewArguments(int argc, char** argv);
RegisterArguments parseRegisterArguments(int argc, char** argv);
ModelRegisterArguments parseModelRegisterArguments(int argc, char** argv);
CoarseRegisterArguments parseCoarseRegisterArguments(int argc, char** argv);
ModelPreviewArguments parseModelPreviewArguments(int argc, char** argv);
} // namespace registration::worker
