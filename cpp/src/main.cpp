// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"
#include "registration/bidirectional_registration.hpp"
#include "registration/matrix.hpp"
#include "registration/ply_reader.hpp"
#include "registration/point_cloud_preview.hpp"
#include "registration/reference_cloud_reader.hpp"

#include <filesystem>
#include <fstream>
#include <chrono>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <limits>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <vector>

namespace
{
bool hasGaussianProperties(const std::filesystem::path& path)
{
    std::ifstream input(path, std::ios::binary);
    if (!input) return false;
    std::unordered_set<std::string> properties;
    std::string line;
    bool binaryLittleEndian = false;
    bool inVertex = false;
    while (std::getline(input, line))
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        std::istringstream values(line);
        std::string keyword;
        values >> keyword;
        if (keyword == "format")
        {
            std::string format;
            values >> format;
            binaryLittleEndian = format == "binary_little_endian";
        }
        else if (keyword == "element")
        {
            std::string name;
            values >> name;
            inVertex = name == "vertex";
        }
        else if (keyword == "property" && inVertex)
        {
            std::string type;
            std::string name;
            values >> type >> name;
            properties.insert(name);
        }
        else if (keyword == "end_header")
        {
            break;
        }
    }
    return binaryLittleEndian
        && properties.count("f_dc_0") != 0 && properties.count("f_dc_1") != 0 && properties.count("f_dc_2") != 0
        && properties.count("opacity") != 0
        && properties.count("scale_0") != 0 && properties.count("scale_1") != 0 && properties.count("scale_2") != 0
        && properties.count("rot_0") != 0 && properties.count("rot_1") != 0
        && properties.count("rot_2") != 0 && properties.count("rot_3") != 0;
}

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

struct PreviewArguments
{
    std::filesystem::path ply;
    std::filesystem::path reference;
    std::filesystem::path outputDirectory;
    std::size_t plyLimit = 300000;
    std::size_t pcdLimit = 300000;
};

PreviewArguments parsePreviewArguments(int argc, char** argv)
{
    PreviewArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        const auto value = [&]() -> std::string {
            if (index + 1 >= argc) throw std::runtime_error("Missing value after " + option);
            return argv[++index];
        };
        if (option == "--ply") result.ply = value();
        else if (option == "--reference" || option == "--pcd") result.reference = value();
        else if (option == "--output-dir") result.outputDirectory = value();
        else if (option == "--ply-limit") result.plyLimit = std::stoull(value());
        else if (option == "--pcd-limit") result.pcdLimit = std::stoull(value());
        else throw std::runtime_error("Unknown prepare-preview option: " + option);
    }
    if (result.ply.empty() || result.reference.empty() || result.outputDirectory.empty())
        throw std::runtime_error("prepare-preview requires --ply, --reference and --output-dir");
    if (result.plyLimit < 3 || result.pcdLimit < 3)
        throw std::runtime_error("Preview point limits must be at least 3");
    return result;
}

struct RegisterArguments
{
    std::filesystem::path ply;
    std::filesystem::path reference;
    std::filesystem::path outputDirectory;
    registration::IcpOptions options;
    std::string precisionMode = "recommended";
    unsigned highAccuracySamplingLimit = 500000;
    unsigned stabilityRuns = 3;
};

RegisterArguments parseRegisterArguments(int argc, char** argv)
{
    RegisterArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        const auto value = [&]() -> std::string {
            if (index + 1 >= argc) throw std::runtime_error("Missing value after " + option);
            return argv[++index];
        };
        if (option == "--ply") result.ply = value();
        else if (option == "--reference" || option == "--pcd") result.reference = value();
        else if (option == "--output-dir") result.outputDirectory = value();
        else if (option == "--min-rms-decrease") result.options.minRmsDecrease = std::stod(value());
        else if (option == "--max-iterations") result.options.maxIterations = static_cast<unsigned>(std::stoul(value()));
        else if (option == "--sampling-limit") result.options.samplingLimit = static_cast<unsigned>(std::stoul(value()));
        else if (option == "--overlap") result.options.finalOverlapRatio = std::stod(value());
        else if (option == "--random-seed") result.options.randomSeed = static_cast<std::uint32_t>(std::stoul(value()));
        else if (option == "--max-threads") result.options.maxThreadCount = std::stoi(value());
        else if (option == "--adjust-scale") result.options.adjustScale = true;
        else if (option == "--filter-farthest") result.options.filterOutFarthestPoints = true;
        else if (option == "--initial-matrix") result.options.initialPcdToPly = registration::Matrix4d::fromFile(value());
        else if (option == "--precision-mode") result.precisionMode = value();
        else if (option == "--high-accuracy-sampling-limit") result.highAccuracySamplingLimit = static_cast<unsigned>(std::stoul(value()));
        else if (option == "--stability-runs") result.stabilityRuns = static_cast<unsigned>(std::stoul(value()));
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

struct ModelRegisterArguments
{
    std::filesystem::path modelA;
    std::filesystem::path modelB;
    std::filesystem::path outputDirectory;
    registration::BidirectionalRegistrationOptions options;
    std::string outputDirection = "a_to_b";
    bool progressJsonLines = false;
    std::optional<registration::Matrix4d> modelAToBusiness;
    std::optional<registration::Matrix4d> modelBToBusiness;
};

ModelRegisterArguments parseModelRegisterArguments(int argc, char** argv)
{
    ModelRegisterArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        const auto value = [&]() -> std::string {
            if (index + 1 >= argc) throw std::runtime_error("Missing value after " + option);
            return argv[++index];
        };
        if (option == "--progress-jsonl") result.progressJsonLines = true;
        else if (option == "--model-a") result.modelA = value();
        else if (option == "--model-b") result.modelB = value();
        else if (option == "--output-dir") result.outputDirectory = value();
        else if (option == "--output-direction") result.outputDirection = value();
        else if (option == "--moving-model")
        {
            const auto moving = value();
            if (moving == "a") result.options.movingModel = registration::MovingModel::A;
            else if (moving == "b") result.options.movingModel = registration::MovingModel::B;
            else if (moving == "auto") result.options.movingModel = registration::MovingModel::Auto;
            else throw std::runtime_error("moving-model must be auto, a, or b");
        }
        else if (option == "--min-rms-decrease") result.options.icp.minRmsDecrease = std::stod(value());
        else if (option == "--max-iterations") result.options.icp.maxIterations = static_cast<unsigned>(std::stoul(value()));
        else if (option == "--sampling-limit") result.options.icp.samplingLimit = static_cast<unsigned>(std::stoul(value()));
        else if (option == "--overlap") result.options.icp.finalOverlapRatio = std::stod(value());
        else if (option == "--random-seed") result.options.icp.randomSeed = static_cast<std::uint32_t>(std::stoul(value()));
        else if (option == "--max-threads") result.options.icp.maxThreadCount = std::stoi(value());
        else if (option == "--adjust-scale") result.options.icp.adjustScale = true;
        else if (option == "--filter-farthest") result.options.icp.filterOutFarthestPoints = true;
        else if (option == "--initial-matrix") result.options.icp.initialMovingLocalToFixedLocal = registration::Matrix4d::fromFile(value());
        else if (option == "--model-a-to-business") result.modelAToBusiness = registration::Matrix4d::fromFile(value());
        else if (option == "--model-b-to-business") result.modelBToBusiness = registration::Matrix4d::fromFile(value());
        else throw std::runtime_error("Unknown register-models option: " + option);
    }
    if (result.modelA.empty() || result.modelB.empty() || result.outputDirectory.empty())
        throw std::runtime_error("register-models requires --model-a, --model-b and --output-dir");
    if (result.outputDirection != "a_to_b" && result.outputDirection != "b_to_a")
        throw std::runtime_error("output-direction must be a_to_b or b_to_a");
    if (result.options.icp.samplingLimit < 3) throw std::runtime_error("sampling-limit must be at least 3");
    return result;
}

struct ModelPreviewArguments
{
    std::filesystem::path modelA;
    std::filesystem::path modelB;
    std::filesystem::path outputDirectory;
    std::size_t modelALimit = 300000;
    std::size_t modelBLimit = 300000;
};

ModelPreviewArguments parseModelPreviewArguments(int argc, char** argv)
{
    ModelPreviewArguments result;
    for (int index = 2; index < argc; ++index)
    {
        const std::string option = argv[index];
        const auto value = [&]() -> std::string {
            if (index + 1 >= argc) throw std::runtime_error("Missing value after " + option);
            return argv[++index];
        };
        if (option == "--model-a") result.modelA = value();
        else if (option == "--model-b") result.modelB = value();
        else if (option == "--output-dir") result.outputDirectory = value();
        else if (option == "--model-a-limit") result.modelALimit = std::stoull(value());
        else if (option == "--model-b-limit") result.modelBLimit = std::stoull(value());
        else throw std::runtime_error("Unknown prepare-model-preview option: " + option);
    }
    if (result.modelA.empty() || result.modelB.empty() || result.outputDirectory.empty())
        throw std::runtime_error("prepare-model-preview requires --model-a, --model-b and --output-dir");
    if (result.modelALimit < 3 || result.modelBLimit < 3)
        throw std::runtime_error("Preview point limits must be at least 3");
    return result;
}

double translationDistance(const registration::Matrix4d& left, const registration::Matrix4d& right)
{
    double squared = 0.0;
    for (std::size_t axis = 0; axis < 3; ++axis)
    {
        const double difference = left.at(axis, 3) - right.at(axis, 3);
        squared += difference * difference;
    }
    return std::sqrt(squared);
}

double rotationDistanceDegrees(const registration::Matrix4d& left, const registration::Matrix4d& right)
{
    double trace = 0.0;
    for (std::size_t row = 0; row < 3; ++row)
        for (std::size_t column = 0; column < 3; ++column)
            trace += left.at(row, column) * right.at(row, column);
    const double cosine = std::clamp((trace - 1.0) * 0.5, -1.0, 1.0);
    return std::acos(cosine) * 57.2957795130823208768;
}

void writeMatrixJson(std::ostream& output, const registration::Matrix4d& matrix, int indent)
{
    output << "[\n";
    for (std::size_t row = 0; row < 4; ++row)
    {
        output << std::string(static_cast<std::size_t>(indent + 2), ' ') << '[';
        for (std::size_t column = 0; column < 4; ++column)
        {
            if (column != 0) output << ", ";
            output << matrix.at(row, column);
        }
        output << ']' << (row == 3 ? "\n" : ",\n");
    }
    output << std::string(static_cast<std::size_t>(indent), ' ') << ']';
}

void writeCompactMatrixJson(std::ostream& output, const registration::Matrix4d& matrix)
{
    output << '[';
    for (std::size_t row = 0; row < 4; ++row)
    {
        if (row != 0) output << ',';
        output << '[';
        for (std::size_t column = 0; column < 4; ++column)
        {
            if (column != 0) output << ',';
            output << matrix.at(row, column);
        }
        output << ']';
    }
    output << ']';
}

registration::Matrix4d translationMatrix(const registration::Point3d& translation)
{
    registration::Matrix4d result;
    for (std::size_t axis = 0; axis < 3; ++axis) result.at(axis, 3) = translation[axis];
    return result;
}

int runRegistration(const RegisterArguments& arguments)
{
    const auto started = std::chrono::steady_clock::now();
    std::filesystem::create_directories(arguments.outputDirectory);
    std::ofstream log(arguments.outputDirectory / "registration.log");
    if (!log) throw std::runtime_error("Cannot create registration log");
    log << "stage=load_ply path=" << arguments.ply.generic_string() << '\n';
    const auto ply = registration::PlyReader().read(arguments.ply);
    log << "ply_points=" << ply.cloud.points.size() << " invalid=" << ply.invalidPointCount << '\n';
    log << "stage=load_reference path=" << arguments.reference.generic_string() << '\n';
    const auto reference = registration::ReferenceCloudReader().read(arguments.reference);
    log << "reference_format=" << reference.format << " reference_points=" << reference.cloud.points.size()
        << " invalid=" << reference.invalidPointCount << " origin=" << reference.origin[0] << ','
        << reference.origin[1] << ',' << reference.origin[2] << '\n';
    log << "stage=icp seed=" << arguments.options.randomSeed
        << " sampling_limit=" << arguments.options.samplingLimit
        << " overlap=" << arguments.options.finalOverlapRatio << '\n';
    const registration::IcpRegistration registrationEngine;
    const auto manualInitial = arguments.options.initialPcdToPly;
    auto result = registrationEngine.registerPcdToPly(reference.cloud, ply.cloud, arguments.options);
    std::vector<registration::IcpResult> stabilityCandidates;
    double translationStabilityMeters = 0.0;
    double rotationStabilityDegrees = 0.0;
    if (arguments.precisionMode == "high_accuracy")
    {
        registration::IcpOptions refinementOptions = arguments.options;
        refinementOptions.samplingLimit = arguments.highAccuracySamplingLimit;
        refinementOptions.initialPcdToPly = result.pcdToPly;
        stabilityCandidates.reserve(arguments.stabilityRuns);
        for (unsigned run = 0; run < arguments.stabilityRuns; ++run)
        {
            refinementOptions.randomSeed = arguments.options.randomSeed + run;
            log << "stage=high_accuracy run=" << run
                << " seed=" << refinementOptions.randomSeed
                << " sampling_limit=" << refinementOptions.samplingLimit << '\n';
            stabilityCandidates.push_back(
                registrationEngine.registerPcdToPly(reference.cloud, ply.cloud, refinementOptions));
        }
        const auto& baseline = stabilityCandidates.front().pcdToPly;
        double translationSquared = 0.0;
        double rotationSquared = 0.0;
        for (const auto& candidate : stabilityCandidates)
        {
            const double translation = translationDistance(candidate.pcdToPly, baseline);
            const double rotation = rotationDistanceDegrees(candidate.pcdToPly, baseline);
            translationSquared += translation * translation;
            rotationSquared += rotation * rotation;
        }
        translationStabilityMeters = std::sqrt(translationSquared / stabilityCandidates.size());
        rotationStabilityDegrees = std::sqrt(rotationSquared / stabilityCandidates.size());
        result = stabilityCandidates.front();
        result.initialPcdToPly = manualInitial;
        result.refinementPcdToPly = result.pcdToPly * manualInitial.inverse();
    }
    registration::Point3d negativeOrigin{-reference.origin[0], -reference.origin[1], -reference.origin[2]};
    const auto referenceWorldToPly = result.pcdToPly * translationMatrix(negativeOrigin);
    const auto plyToReferenceWorld = translationMatrix(reference.origin) * result.plyToPcd;
    const auto referenceWorldToPlyCloudCompare = referenceWorldToPly.toFloatCompatible();
    const auto plyToReferenceWorldCloudCompare = plyToReferenceWorld.toFloatCompatible();

    const auto writeMatrix = [&](const std::string& name, const registration::Matrix4d& matrix) {
        std::ofstream output(arguments.outputDirectory / name);
        if (!output) throw std::runtime_error("Cannot create matrix file: " + name);
        output << matrix.toString();
    };
    writeMatrix("reference_to_ply_matrix.txt", referenceWorldToPly);
    writeMatrix("ply_to_reference_matrix.txt", plyToReferenceWorld);
    writeMatrix("reference_local_to_ply_matrix.txt", result.pcdToPly);
    writeMatrix("initial_reference_local_to_ply_matrix.txt", result.initialPcdToPly);
    writeMatrix("icp_refinement_reference_local_to_ply_matrix.txt", result.refinementPcdToPly);
    writeMatrix("initial_pcd_to_ply_matrix.txt", result.initialPcdToPly);
    writeMatrix("icp_refinement_pcd_to_ply_matrix.txt", result.refinementPcdToPly);
    writeMatrix("reference_to_ply_cloudcompare_matrix.txt", referenceWorldToPlyCloudCompare);
    writeMatrix("ply_to_reference_cloudcompare_matrix.txt", plyToReferenceWorldCloudCompare);
    if (reference.format == "pcd")
    {
        writeMatrix("pcd_to_ply_matrix.txt", referenceWorldToPly);
        writeMatrix("ply_to_pcd_matrix.txt", plyToReferenceWorld);
        writeMatrix("pcd_to_ply_cloudcompare_matrix.txt", referenceWorldToPlyCloudCompare);
        writeMatrix("ply_to_pcd_cloudcompare_matrix.txt", plyToReferenceWorldCloudCompare);
    }

    const double elapsedSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    std::ofstream output(arguments.outputDirectory / "registration.json");
    if (!output) throw std::runtime_error("Cannot create registration result file");
    output << std::fixed << std::setprecision(12)
           << "{\n"
           << "  \"status\": \"success\",\n"
           << "  \"formula\": \"p_reference_world = T_ply_to_reference * p_ply\",\n"
           << "  \"matrix_convention\": \"column_vector\",\n"
           << "  \"reference_format\": \"" << reference.format << "\",\n"
           << "  \"reference_origin\": [" << reference.origin[0] << ", " << reference.origin[1] << ", " << reference.origin[2] << "],\n"
           << "  \"initial_reference_local_to_ply\": ";
    writeMatrixJson(output, result.initialPcdToPly, 2);
    output << ",\n  \"icp_refinement_reference_local_to_ply\": ";
    writeMatrixJson(output, result.refinementPcdToPly, 2);
    output << ",\n"
           << "  \"initial_pcd_to_ply\": ";
    writeMatrixJson(output, result.initialPcdToPly, 2);
    output << ",\n  \"icp_refinement_pcd_to_ply\": ";
    writeMatrixJson(output, result.refinementPcdToPly, 2);
    output << ",\n"
           << "  \"reference_local_to_ply\": ";
    writeMatrixJson(output, result.pcdToPly, 2);
    output << ",\n  \"reference_to_ply\": ";
    writeMatrixJson(output, referenceWorldToPly, 2);
    output << ",\n  \"ply_to_reference\": ";
    writeMatrixJson(output, plyToReferenceWorld, 2);
    output << ",\n  \"reference_to_ply_cloudcompare\": ";
    writeMatrixJson(output, referenceWorldToPlyCloudCompare, 2);
    output << ",\n  \"ply_to_reference_cloudcompare\": ";
    writeMatrixJson(output, plyToReferenceWorldCloudCompare, 2);
    if (reference.format == "pcd")
    {
        output << ",\n  \"pcd_to_ply\": ";
        writeMatrixJson(output, referenceWorldToPly, 2);
        output << ",\n  \"ply_to_pcd\": ";
        writeMatrixJson(output, plyToReferenceWorld, 2);
        output << ",\n  \"pcd_to_ply_cloudcompare\": ";
        writeMatrixJson(output, referenceWorldToPlyCloudCompare, 2);
        output << ",\n  \"ply_to_pcd_cloudcompare\": ";
        writeMatrixJson(output, plyToReferenceWorldCloudCompare, 2);
    }
    output << ",\n"
           << "  \"metrics\": {\n"
           << "    \"final_rms\": " << result.finalRms << ",\n"
           << "    \"final_point_count\": " << result.finalPointCount << ",\n"
           << "    \"scale\": " << result.scale << ",\n"
           << "    \"elapsed_seconds\": " << elapsedSeconds << "\n"
           << "  },\n"
           << "  \"parameters\": {\n"
           << "    \"min_rms_decrease\": " << arguments.options.minRmsDecrease << ",\n"
           << "    \"max_iterations\": " << arguments.options.maxIterations << ",\n"
           << "    \"sampling_limit\": " << arguments.options.samplingLimit << ",\n"
           << "    \"overlap\": " << arguments.options.finalOverlapRatio << ",\n"
           << "    \"random_seed\": " << arguments.options.randomSeed << ",\n"
           << "    \"adjust_scale\": " << (arguments.options.adjustScale ? "true" : "false") << ",\n"
           << "    \"filter_farthest\": " << (arguments.options.filterOutFarthestPoints ? "true" : "false") << "\n"
           << "  },\n"
           << "  \"precision\": {\n"
           << "    \"mode\": \"" << arguments.precisionMode << "\",\n"
           << "    \"high_accuracy_sampling_limit\": " << arguments.highAccuracySamplingLimit << ",\n"
           << "    \"stability_runs\": " << (arguments.precisionMode == "high_accuracy" ? stabilityCandidates.size() : 1) << ",\n"
           << "    \"translation_stability_m\": " << translationStabilityMeters << ",\n"
           << "    \"rotation_stability_deg\": " << rotationStabilityDegrees << ",\n"
           << "    \"translation_threshold_m\": 0.020000000000,\n"
           << "    \"rotation_threshold_deg\": 0.200000000000,\n"
           << "    \"stable\": " << ((translationStabilityMeters <= 0.02 && rotationStabilityDegrees <= 0.2) ? "true" : "false") << ",\n"
           << "    \"candidates\": [";
    for (std::size_t index = 0; index < stabilityCandidates.size(); ++index)
    {
        const auto& candidate = stabilityCandidates[index];
        output << (index == 0 ? "\n" : ",\n")
               << "      {\"seed\": " << (arguments.options.randomSeed + static_cast<unsigned>(index))
               << ", \"final_rms\": " << candidate.finalRms << ", \"reference_local_to_ply\": ";
        writeMatrixJson(output, candidate.pcdToPly, 6);
        output << '}';
    }
    if (!stabilityCandidates.empty()) output << '\n';
    output << "    ]\n"
           << "  }\n"
           << "}\n";
    log << "stage=complete final_rms=" << result.finalRms
        << " final_point_count=" << result.finalPointCount
        << " elapsed_seconds=" << elapsedSeconds << '\n';
    std::cout << "{\"status\":\"success\",\"output_dir\":\""
              << arguments.outputDirectory.generic_string() << "\"}\n";
    return 0;
}

int runModelRegistration(const ModelRegisterArguments& arguments)
{
    const auto started = std::chrono::steady_clock::now();
    std::filesystem::create_directories(arguments.outputDirectory);
    auto modelA = registration::ReferenceCloudReader().read(arguments.modelA);
    auto modelB = registration::ReferenceCloudReader().read(arguments.modelB);
    const auto transformToBusiness = [](registration::ReferenceCloudReadResult& model,
                                        const registration::Matrix4d& matrix) {
        registration::Point3d businessOrigin{};
        for (std::size_t row = 0; row < 3; ++row)
        {
            businessOrigin[row] = matrix.at(row, 3);
            for (std::size_t column = 0; column < 3; ++column)
                businessOrigin[row] += matrix.at(row, column) * model.origin[column];
        }
        registration::BoundingBox3d bounds;
        bounds.min = {std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity(), std::numeric_limits<double>::infinity()};
        bounds.max = {-std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity()};
        for (auto& point : model.cloud.points)
        {
            registration::Point3d transformed{};
            for (std::size_t row = 0; row < 3; ++row)
                for (std::size_t column = 0; column < 3; ++column)
                    transformed[row] += matrix.at(row, column) * static_cast<double>(point[column]);
            for (std::size_t axis = 0; axis < 3; ++axis)
            {
                point[axis] = static_cast<float>(transformed[axis]);
                bounds.min[axis] = std::min(bounds.min[axis], businessOrigin[axis] + transformed[axis]);
                bounds.max[axis] = std::max(bounds.max[axis], businessOrigin[axis] + transformed[axis]);
            }
        }
        model.origin = businessOrigin;
        model.worldBounds = bounds;
    };
    if (arguments.modelAToBusiness.has_value() != arguments.modelBToBusiness.has_value())
        throw std::runtime_error("Both business transform matrices are required");
    if (arguments.modelAToBusiness)
    {
        transformToBusiness(modelA, *arguments.modelAToBusiness);
        transformToBusiness(modelB, *arguments.modelBToBusiness);
    }
    auto options = arguments.options;
    if (arguments.progressJsonLines)
    {
        options.icp.iterationCallback = [&](const registration::IcpIterationState& state) {
            const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
            std::cout << std::fixed << std::setprecision(12)
                      << "{\"type\":\"iteration\",\"iteration\":" << state.iteration
                      << ",\"rms\":" << state.rms << ",\"point_count\":" << state.pointCount
                      << ",\"elapsed_seconds\":" << elapsed
                      << ",\"moving_local_to_fixed_local\":";
            writeCompactMatrixJson(std::cout, state.movingLocalToFixedLocal);
            std::cout << "}\n" << std::flush;
        };
    }
    const auto result = registration::BidirectionalRegistration().registerModels(
        std::move(modelA), std::move(modelB), options);
    const auto movingName = result.movingModel == registration::MovingModel::A ? "a" : "b";
    const auto& recommended = arguments.outputDirection == "a_to_b" ? result.aToB : result.bToA;
    const auto recommendedName = arguments.outputDirection == "a_to_b" ? "T_a_to_b" : "T_b_to_a";
    const auto recommendedFormula = arguments.outputDirection == "a_to_b"
        ? "p_b = T_a_to_b * p_a" : "p_a = T_b_to_a * p_b";

    const auto writeMatrix = [&](const std::string& name, const registration::Matrix4d& matrix) {
        std::ofstream output(arguments.outputDirectory / name);
        if (!output) throw std::runtime_error("Cannot create matrix file: " + name);
        output << matrix.toString();
    };
    writeMatrix("a_to_b_matrix.txt", result.aToB);
    writeMatrix("b_to_a_matrix.txt", result.bToA);
    writeMatrix("moving_local_to_fixed_local_matrix.txt", result.movingLocalToFixedLocal);
    writeMatrix("initial_moving_local_to_fixed_local_matrix.txt", result.initialMovingLocalToFixedLocal);
    writeMatrix("icp_refinement_moving_local_to_fixed_local_matrix.txt", result.refinementMovingLocalToFixedLocal);

    const double elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    std::ofstream output(arguments.outputDirectory / "registration.json");
    if (!output) throw std::runtime_error("Cannot create registration result file");
    output << std::fixed << std::setprecision(12)
           << "{\n  \"status\": \"success\",\n"
           << "  \"matrix_convention\": \"column_vector\",\n"
           << "  \"output_direction\": \"" << arguments.outputDirection << "\",\n"
           << "  \"moving_model\": \"" << movingName << "\",\n"
           << "  \"fixed_model\": \"" << (result.movingModel == registration::MovingModel::A ? "b" : "a") << "\",\n"
           << "  \"recommended_matrix\": {\"name\": \"" << recommendedName
           << "\", \"formula\": \"" << recommendedFormula << "\", \"value\": ";
    writeMatrixJson(output, recommended, 2);
    output << "},\n  \"model_a\": {\"format\": \"" << result.modelA.format << "\", \"origin\": ["
           << result.modelA.origin[0] << ", " << result.modelA.origin[1] << ", " << result.modelA.origin[2]
           << "], \"point_count\": " << result.modelA.cloud.points.size() << "},\n"
           << "  \"model_b\": {\"format\": \"" << result.modelB.format << "\", \"origin\": ["
           << result.modelB.origin[0] << ", " << result.modelB.origin[1] << ", " << result.modelB.origin[2]
           << "], \"point_count\": " << result.modelB.cloud.points.size() << "},\n"
           << "  \"initial_moving_local_to_fixed_local\": ";
    writeMatrixJson(output, result.initialMovingLocalToFixedLocal, 2);
    output << ",\n  \"icp_refinement_moving_local_to_fixed_local\": ";
    writeMatrixJson(output, result.refinementMovingLocalToFixedLocal, 2);
    output << ",\n  \"moving_local_to_fixed_local\": ";
    writeMatrixJson(output, result.movingLocalToFixedLocal, 2);
    output << ",\n  \"a_to_b\": ";
    writeMatrixJson(output, result.aToB, 2);
    output << ",\n  \"b_to_a\": ";
    writeMatrixJson(output, result.bToA, 2);
    output << ",\n  \"metrics\": {\"final_rms\": " << result.finalRms
           << ", \"final_point_count\": " << result.finalPointCount
           << ", \"scale\": " << result.scale << ", \"elapsed_seconds\": " << elapsed << "},\n"
           << "  \"parameters\": {\"min_rms_decrease\": " << arguments.options.icp.minRmsDecrease
           << ", \"sampling_limit\": " << arguments.options.icp.samplingLimit
           << ", \"overlap\": " << arguments.options.icp.finalOverlapRatio
           << ", \"random_seed\": " << arguments.options.icp.randomSeed << "}\n}\n";
    std::cout << "{\"status\":\"success\",\"output_dir\":\""
              << arguments.outputDirectory.generic_string() << "\"}\n";
    return 0;
}

int runPreview(const PreviewArguments& arguments)
{
    std::filesystem::create_directories(arguments.outputDirectory);
    const auto ply = registration::PlyReader().read(arguments.ply);
    const auto reference = registration::ReferenceCloudReader().read(arguments.reference);
    const registration::PointCloudPreview writer;
    const auto plyPreview = writer.write(ply.cloud, arguments.plyLimit,
                                         arguments.outputDirectory / "ply-points.bin");
    const auto pcdPreview = writer.write(reference.cloud, arguments.pcdLimit,
                                         arguments.outputDirectory / "pcd-points.bin");
    const bool gaussianAvailable = hasGaussianProperties(arguments.ply);
    std::ofstream metadata(arguments.outputDirectory / "metadata.json");
    if (!metadata) throw std::runtime_error("Cannot create preview metadata");
    metadata << std::fixed << std::setprecision(12);
    const auto writeSummary = [&](const char* name, const registration::PreviewResult& result, bool comma) {
        metadata << "    \"" << name << "\": {\n"
                 << "      \"source_point_count\": " << result.sourcePointCount << ",\n"
                 << "      \"preview_point_count\": " << result.previewPointCount << ",\n"
                 << "      \"bounds\": {\"min\": [" << result.bounds.min[0] << ", "
                 << result.bounds.min[1] << ", " << result.bounds.min[2] << "], \"max\": ["
                 << result.bounds.max[0] << ", " << result.bounds.max[1] << ", "
                 << result.bounds.max[2] << "]}\n"
                 << "    }" << (comma ? "," : "") << "\n";
    };
    metadata << "{\n  \"format\": \"PCPV0001\",\n"
             << "  \"reference_format\": \"" << reference.format << "\",\n"
             << "  \"reference_origin\": [" << reference.origin[0] << ", " << reference.origin[1] << ", " << reference.origin[2] << "],\n"
             << "  \"gaussian_available\": " << (gaussianAvailable ? "true" : "false") << ",\n";
    if (!gaussianAvailable)
        metadata << "  \"gaussian_error\": \"PLY does not contain a supported Gaussian attribute set\",\n";
    metadata << "  \"clouds\": {\n";
    writeSummary("ply", plyPreview, true);
    writeSummary("pcd", pcdPreview, true);
    writeSummary("reference", pcdPreview, false);
    metadata << "  }\n}\n";
    std::cout << "{\"status\":\"success\",\"output_dir\":\""
              << arguments.outputDirectory.generic_string() << "\"}\n";
    return 0;
}

int runModelPreview(const ModelPreviewArguments& arguments)
{
    std::filesystem::create_directories(arguments.outputDirectory);
    const auto modelA = registration::ReferenceCloudReader().read(arguments.modelA);
    const auto modelB = registration::ReferenceCloudReader().read(arguments.modelB);
    const registration::PointCloudPreview writer;
    const auto previewA = writer.write(modelA.cloud, arguments.modelALimit,
                                       arguments.outputDirectory / "model-a-points.bin");
    const auto previewB = writer.write(modelB.cloud, arguments.modelBLimit,
                                       arguments.outputDirectory / "model-b-points.bin");
    std::ofstream metadata(arguments.outputDirectory / "metadata.json");
    if (!metadata) throw std::runtime_error("Cannot create preview metadata");
    metadata << std::fixed << std::setprecision(12);
    const auto writeModel = [&](const char* name, const registration::ReferenceCloudReadResult& model,
                                const registration::PreviewResult& preview, bool comma) {
        metadata << "    \"" << name << "\": {\"format\": \"" << model.format
                 << "\", \"source_point_count\": " << preview.sourcePointCount
                 << ", \"preview_point_count\": " << preview.previewPointCount
                 << ", \"origin\": [" << model.origin[0] << ", " << model.origin[1] << ", " << model.origin[2]
                 << "], \"bounds\": {\"min\": [" << preview.bounds.min[0] << ", "
                 << preview.bounds.min[1] << ", " << preview.bounds.min[2] << "], \"max\": ["
                 << preview.bounds.max[0] << ", " << preview.bounds.max[1] << ", "
                 << preview.bounds.max[2] << "]}}" << (comma ? "," : "") << '\n';
    };
    metadata << "{\n  \"format\": \"PCPV0001\",\n"
             << "  \"recommended_moving_model\": \""
             << (registration::BidirectionalRegistration::recommendMovingModel(modelA, modelB)
                 == registration::MovingModel::A ? "a" : "b") << "\",\n"
             << "  \"gaussian_a_available\": "
             << (modelA.format == "ply" && hasGaussianProperties(arguments.modelA) ? "true" : "false") << ",\n"
             << "  \"gaussian_b_available\": "
             << (modelB.format == "ply" && hasGaussianProperties(arguments.modelB) ? "true" : "false") << ",\n"
             << "  \"models\": {\n";
    writeModel("a", modelA, previewA, true);
    writeModel("b", modelB, previewB, false);
    metadata << "  }\n}\n";
    std::cout << "{\"status\":\"success\",\"output_dir\":\""
              << arguments.outputDirectory.generic_string() << "\"}\n";
    return 0;
}

void printCloudSummary(const std::string& type,
                       std::uint64_t declared,
                       std::uint64_t valid,
                       std::uint64_t invalid,
                       const registration::BoundingBox& box)
{
    std::cout << std::fixed << std::setprecision(6)
              << "{\n"
              << "  \"type\": \"" << type << "\",\n"
              << "  \"declared_points\": " << declared << ",\n"
              << "  \"valid_points\": " << valid << ",\n"
              << "  \"invalid_points\": " << invalid << ",\n"
              << "  \"bounds\": {\n"
              << "    \"min\": [" << box.min[0] << ", " << box.min[1] << ", " << box.min[2] << "],\n"
              << "    \"max\": [" << box.max[0] << ", " << box.max[1] << ", " << box.max[2] << "]\n"
              << "  }\n"
              << "}\n";
}
} // namespace

int main(int argc, char** argv)
{
    try
    {
        if (argc < 2)
        {
            printUsage();
            return 10;
        }
        const std::string command = argv[1];
        if (command == "register")
        {
            return runRegistration(parseRegisterArguments(argc, argv));
        }
        if (command == "register-models")
        {
            return runModelRegistration(parseModelRegisterArguments(argc, argv));
        }
        if (command == "prepare-preview")
        {
            return runPreview(parsePreviewArguments(argc, argv));
        }
        if (command == "prepare-model-preview")
        {
            return runModelPreview(parseModelPreviewArguments(argc, argv));
        }

        if (argc != 3)
        {
            printUsage();
            return 10;
        }
        const std::filesystem::path path = argv[2];
        if (command == "inspect-ply")
        {
            const auto result = registration::PlyReader().read(path);
            printCloudSummary("ply", result.declaredVertexCount, result.cloud.points.size(),
                              result.invalidPointCount, result.cloud.boundingBox());
            return 0;
        }
        if (command == "inspect-pcd" || command == "inspect-reference")
        {
            const auto result = registration::ReferenceCloudReader().read(path);
            printCloudSummary(result.format, result.declaredPointCount, result.cloud.points.size(),
                              result.invalidPointCount, result.cloud.boundingBox());
            return 0;
        }
        if (command == "invert-matrix")
        {
            std::cout << registration::Matrix4d::fromFile(path).inverse().toString();
            return 0;
        }
        printUsage();
        return 10;
    }
    catch (const std::exception& error)
    {
        std::cerr << "registration_worker: " << error.what() << '\n';
        return 50;
    }
}
