// SPDX-License-Identifier: GPL-3.0-or-later
#include "worker_arguments.hpp"

#include <iostream>
#include <stdexcept>
#include <sstream>

namespace registration::worker
{
namespace
{
std::string nextValue(int& index, int argc, char** argv, const std::string& option)
{
    if (index + 1 >= argc) throw std::runtime_error("Missing value after " + option);
    return argv[++index];
}

template <typename Value, typename Parse>
std::vector<Value> commaSeparated(const std::string& text, Parse parse)
{
    std::vector<Value> values;
    std::istringstream input(text);
    std::string item;
    while (std::getline(input, item, ','))
        if (!item.empty()) values.push_back(parse(item));
    if (values.empty()) throw std::runtime_error("Comma-separated option must contain a value");
    return values;
}
} // namespace

void printUsage()
{
    std::cout
        << "Usage:\n"
        << "  registration_worker inspect-ply <file.ply>\n"
        << "  registration_worker inspect-reference <file.pcd|file.las|file.laz>\n"
        << "  registration_worker invert-matrix <matrix.txt>\n"
        << "  registration_worker prepare-preview --ply <model.ply> --reference <data.pcd|data.las|data.laz> --output-dir <dir> [options]\n"
        << "  registration_worker register --ply <model.ply> --reference <data.pcd|data.las|data.laz> --output-dir <dir> [options]\n\n"
        << "  registration_worker register-models --model-a <file> --model-b <file> --moving-model <auto|a|b> --output-direction <a_to_b|b_to_a> --output-dir <dir> [options]\n\n"
        << "  registration_worker coarse-register-models --model-a <file> --model-b <file> --moving-model <a|b> --output-dir <dir> [options]\n\n"
        << "  registration_worker prepare-model-preview --model-a <file> --model-b <file> --output-dir <dir> [options]\n\n"
        << "Register options:\n"
        << "  --min-rms-decrease <value>  Default: 1e-5\n"
        << "  --max-iterations <count>     Default: RMS convergence\n"
        << "  --sampling-limit <count>     Default: 50000\n"
        << "  --overlap <0..1>             Default: 1.0\n"
        << "  --random-seed <count>        Default: 42\n"
        << "  --max-threads <count>        Default: 0\n"
        << "  --adjust-scale               Default: disabled\n"
        << "  --filter-farthest            Default: disabled\n"
        << "  --initial-matrix <file>      Initial rigid moving-local-to-fixed-local matrix\n"
        << "  --progress-jsonl             Emit one JSON line after each accepted ICP iteration\n";
}

CoarseRegisterArguments parseCoarseRegisterArguments(int argc, char** argv)
{
    CoarseRegisterArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        if (option == "--model-a") result.modelA = nextValue(index, argc, argv, option);
        else if (option == "--model-b") result.modelB = nextValue(index, argc, argv, option);
        else if (option == "--output-dir") result.outputDirectory = nextValue(index, argc, argv, option);
        else if (option == "--moving-model")
        {
            const auto moving = nextValue(index, argc, argv, option);
            if (moving == "a") result.movingModel = MovingModel::A;
            else if (moving == "b") result.movingModel = MovingModel::B;
            else throw std::runtime_error("coarse moving-model must be a or b");
        }
        else if (option == "--delta") result.options.delta = std::stod(nextValue(index, argc, argv, option));
        else if (option == "--beta") result.options.beta = std::stod(nextValue(index, argc, argv, option));
        else if (option == "--overlap") result.overlaps = {std::stod(nextValue(index, argc, argv, option))};
        else if (option == "--overlaps") result.overlaps = commaSeparated<double>(
            nextValue(index, argc, argv, option), [](const std::string& value) { return std::stod(value); });
        else if (option == "--base-count") result.options.baseCount = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--base-tries") result.options.baseTries = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--max-candidates") result.options.maxCandidates = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--sample-limit") result.options.sampleLimit = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--random-seed") result.randomSeeds = {static_cast<std::uint32_t>(std::stoul(nextValue(index, argc, argv, option)))};
        else if (option == "--random-seeds") result.randomSeeds = commaSeparated<std::uint32_t>(
            nextValue(index, argc, argv, option), [](const std::string& value) { return static_cast<std::uint32_t>(std::stoul(value)); });
        else if (option == "--model-a-to-business") result.modelAToBusiness = Matrix4d::fromFile(nextValue(index, argc, argv, option));
        else if (option == "--model-b-to-business") result.modelBToBusiness = Matrix4d::fromFile(nextValue(index, argc, argv, option));
        else throw std::runtime_error("Unknown coarse-register-models option: " + option);
    }
    if (result.modelA.empty() || result.modelB.empty() || result.outputDirectory.empty())
        throw std::runtime_error("coarse-register-models requires --model-a, --model-b and --output-dir");
    if (result.modelAToBusiness.has_value() != result.modelBToBusiness.has_value())
        throw std::runtime_error("Both business transform matrices are required");
    return result;
}

PreviewArguments parsePreviewArguments(int argc, char** argv)
{
    PreviewArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        if (option == "--ply") result.ply = nextValue(index, argc, argv, option);
        else if (option == "--reference" || option == "--pcd") result.reference = nextValue(index, argc, argv, option);
        else if (option == "--output-dir") result.outputDirectory = nextValue(index, argc, argv, option);
        else if (option == "--ply-limit") result.plyLimit = std::stoull(nextValue(index, argc, argv, option));
        else if (option == "--pcd-limit") result.pcdLimit = std::stoull(nextValue(index, argc, argv, option));
        else throw std::runtime_error("Unknown prepare-preview option: " + option);
    }
    if (result.ply.empty() || result.reference.empty() || result.outputDirectory.empty())
        throw std::runtime_error("prepare-preview requires --ply, --reference and --output-dir");
    if (result.plyLimit < 3 || result.pcdLimit < 3)
        throw std::runtime_error("Preview point limits must be at least 3");
    return result;
}

RegisterArguments parseRegisterArguments(int argc, char** argv)
{
    RegisterArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        if (option == "--ply") result.ply = nextValue(index, argc, argv, option);
        else if (option == "--reference" || option == "--pcd") result.reference = nextValue(index, argc, argv, option);
        else if (option == "--output-dir") result.outputDirectory = nextValue(index, argc, argv, option);
        else if (option == "--min-rms-decrease") result.options.minRmsDecrease = std::stod(nextValue(index, argc, argv, option));
        else if (option == "--max-iterations") result.options.maxIterations = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--sampling-limit") result.options.samplingLimit = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--overlap") result.options.finalOverlapRatio = std::stod(nextValue(index, argc, argv, option));
        else if (option == "--random-seed") result.options.randomSeed = static_cast<std::uint32_t>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--max-threads") result.options.maxThreadCount = std::stoi(nextValue(index, argc, argv, option));
        else if (option == "--adjust-scale") result.options.adjustScale = true;
        else if (option == "--filter-farthest") result.options.filterOutFarthestPoints = true;
        else if (option == "--initial-matrix") result.options.initialPcdToPly = Matrix4d::fromFile(nextValue(index, argc, argv, option));
        else if (option == "--precision-mode") result.precisionMode = nextValue(index, argc, argv, option);
        else if (option == "--high-accuracy-sampling-limit") result.highAccuracySamplingLimit = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--stability-runs") result.stabilityRuns = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else throw std::runtime_error("Unknown register option: " + option);
    }
    if (result.ply.empty() || result.reference.empty() || result.outputDirectory.empty())
        throw std::runtime_error("register requires --ply, --reference and --output-dir");
    if (result.options.samplingLimit < 3) throw std::runtime_error("sampling-limit must be at least 3");
    if (result.options.minRmsDecrease <= 0.0) throw std::runtime_error("min-rms-decrease must be positive");
    if (result.precisionMode != "recommended" && result.precisionMode != "high_accuracy")
        throw std::runtime_error("precision-mode must be recommended or high_accuracy");
    if (result.highAccuracySamplingLimit < result.options.samplingLimit)
        throw std::runtime_error("high-accuracy-sampling-limit must not be below sampling-limit");
    if (result.stabilityRuns < 3 || result.stabilityRuns > 10)
        throw std::runtime_error("stability-runs must be between 3 and 10");
    return result;
}

ModelRegisterArguments parseModelRegisterArguments(int argc, char** argv)
{
    ModelRegisterArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        if (option == "--progress-jsonl") result.progressJsonLines = true;
        else if (option == "--model-a") result.modelA = nextValue(index, argc, argv, option);
        else if (option == "--model-b") result.modelB = nextValue(index, argc, argv, option);
        else if (option == "--output-dir") result.outputDirectory = nextValue(index, argc, argv, option);
        else if (option == "--output-direction") result.outputDirection = nextValue(index, argc, argv, option);
        else if (option == "--moving-model")
        {
            const auto moving = nextValue(index, argc, argv, option);
            if (moving == "a") result.options.movingModel = MovingModel::A;
            else if (moving == "b") result.options.movingModel = MovingModel::B;
            else if (moving == "auto") result.options.movingModel = MovingModel::Auto;
            else throw std::runtime_error("moving-model must be auto, a, or b");
        }
        else if (option == "--min-rms-decrease") result.options.icp.minRmsDecrease = std::stod(nextValue(index, argc, argv, option));
        else if (option == "--max-iterations") result.options.icp.maxIterations = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--sampling-limit") result.options.icp.samplingLimit = static_cast<unsigned>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--overlap") result.options.icp.finalOverlapRatio = std::stod(nextValue(index, argc, argv, option));
        else if (option == "--random-seed") result.options.icp.randomSeed = static_cast<std::uint32_t>(std::stoul(nextValue(index, argc, argv, option)));
        else if (option == "--max-threads") result.options.icp.maxThreadCount = std::stoi(nextValue(index, argc, argv, option));
        else if (option == "--adjust-scale") result.options.icp.adjustScale = true;
        else if (option == "--filter-farthest") result.options.icp.filterOutFarthestPoints = true;
        else if (option == "--initial-matrix") result.options.icp.initialMovingLocalToFixedLocal = Matrix4d::fromFile(nextValue(index, argc, argv, option));
        else if (option == "--model-a-to-business") result.modelAToBusiness = Matrix4d::fromFile(nextValue(index, argc, argv, option));
        else if (option == "--model-b-to-business") result.modelBToBusiness = Matrix4d::fromFile(nextValue(index, argc, argv, option));
        else throw std::runtime_error("Unknown register-models option: " + option);
    }
    if (result.modelA.empty() || result.modelB.empty() || result.outputDirectory.empty())
        throw std::runtime_error("register-models requires --model-a, --model-b and --output-dir");
    if (result.outputDirection != "a_to_b" && result.outputDirection != "b_to_a")
        throw std::runtime_error("output-direction must be a_to_b or b_to_a");
    if (result.options.icp.samplingLimit < 3) throw std::runtime_error("sampling-limit must be at least 3");
    return result;
}

ModelPreviewArguments parseModelPreviewArguments(int argc, char** argv)
{
    ModelPreviewArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        if (option == "--model-a") result.modelA = nextValue(index, argc, argv, option);
        else if (option == "--model-b") result.modelB = nextValue(index, argc, argv, option);
        else if (option == "--output-dir") result.outputDirectory = nextValue(index, argc, argv, option);
        else if (option == "--model-a-limit") result.modelALimit = std::stoull(nextValue(index, argc, argv, option));
        else if (option == "--model-b-limit") result.modelBLimit = std::stoull(nextValue(index, argc, argv, option));
        else throw std::runtime_error("Unknown prepare-model-preview option: " + option);
    }
    if (result.modelA.empty() || result.modelB.empty() || result.outputDirectory.empty())
        throw std::runtime_error("prepare-model-preview requires --model-a, --model-b and --output-dir");
    if (result.modelALimit < 3 || result.modelBLimit < 3)
        throw std::runtime_error("Preview point limits must be at least 3");
    return result;
}
} // namespace registration::worker
