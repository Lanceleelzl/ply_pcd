// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"
#include "registration/matrix.hpp"
#include "registration/pcd_reader.hpp"
#include "registration/ply_reader.hpp"
#include "registration/point_cloud_preview.hpp"

#include <filesystem>
#include <fstream>
#include <chrono>
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iomanip>
#include <iostream>
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
        << "  registration_worker inspect-pcd <file.pcd>\n"
        << "  registration_worker invert-matrix <matrix.txt>\n"
        << "  registration_worker prepare-preview --ply <model.ply> --pcd <data.pcd> --output-dir <dir> [options]\n"
        << "  registration_worker register --ply <model.ply> --pcd <data.pcd> --output-dir <dir> [options]\n\n"
        << "Register options:\n"
        << "  --min-rms-decrease <value>  Default: 1e-5\n"
        << "  --max-iterations <count>     Default: RMS convergence\n"
        << "  --sampling-limit <count>     Default: 50000\n"
        << "  --overlap <0..1>             Default: 1.0\n"
        << "  --random-seed <count>        Default: 42\n"
        << "  --max-threads <count>        Default: 0\n"
        << "  --adjust-scale               Default: disabled\n"
        << "  --filter-farthest            Default: disabled\n"
        << "  --initial-matrix <file>      Initial rigid PCD-to-PLY matrix\n";
}

struct PreviewArguments
{
    std::filesystem::path ply;
    std::filesystem::path pcd;
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
        else if (option == "--pcd") result.pcd = value();
        else if (option == "--output-dir") result.outputDirectory = value();
        else if (option == "--ply-limit") result.plyLimit = std::stoull(value());
        else if (option == "--pcd-limit") result.pcdLimit = std::stoull(value());
        else throw std::runtime_error("Unknown prepare-preview option: " + option);
    }
    if (result.ply.empty() || result.pcd.empty() || result.outputDirectory.empty())
        throw std::runtime_error("prepare-preview requires --ply, --pcd and --output-dir");
    if (result.plyLimit < 3 || result.pcdLimit < 3)
        throw std::runtime_error("Preview point limits must be at least 3");
    return result;
}

struct RegisterArguments
{
    std::filesystem::path ply;
    std::filesystem::path pcd;
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
        else if (option == "--pcd") result.pcd = value();
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
    if (result.ply.empty() || result.pcd.empty() || result.outputDirectory.empty())
        throw std::runtime_error("register requires --ply, --pcd and --output-dir");
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

int runRegistration(const RegisterArguments& arguments)
{
    const auto started = std::chrono::steady_clock::now();
    std::filesystem::create_directories(arguments.outputDirectory);
    std::ofstream log(arguments.outputDirectory / "registration.log");
    if (!log) throw std::runtime_error("Cannot create registration log");
    log << "stage=load_ply path=" << arguments.ply.generic_string() << '\n';
    const auto ply = registration::PlyReader().read(arguments.ply);
    log << "ply_points=" << ply.cloud.points.size() << " invalid=" << ply.invalidPointCount << '\n';
    log << "stage=load_pcd path=" << arguments.pcd.generic_string() << '\n';
    const auto pcd = registration::PcdReader().read(arguments.pcd);
    log << "pcd_points=" << pcd.cloud.points.size() << " invalid=" << pcd.invalidPointCount << '\n';
    log << "stage=icp seed=" << arguments.options.randomSeed
        << " sampling_limit=" << arguments.options.samplingLimit
        << " overlap=" << arguments.options.finalOverlapRatio << '\n';
    const registration::IcpRegistration registrationEngine;
    const auto manualInitial = arguments.options.initialPcdToPly;
    auto result = registrationEngine.registerPcdToPly(pcd.cloud, ply.cloud, arguments.options);
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
                registrationEngine.registerPcdToPly(pcd.cloud, ply.cloud, refinementOptions));
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
    const auto pcdToPlyCloudCompare = result.pcdToPly.toFloatCompatible();
    const auto plyToPcdCloudCompare = result.plyToPcd.toFloatCompatible();

    const auto writeMatrix = [&](const std::string& name, const registration::Matrix4d& matrix) {
        std::ofstream output(arguments.outputDirectory / name);
        if (!output) throw std::runtime_error("Cannot create matrix file: " + name);
        output << matrix.toString();
    };
    writeMatrix("pcd_to_ply_matrix.txt", result.pcdToPly);
    writeMatrix("ply_to_pcd_matrix.txt", result.plyToPcd);
    writeMatrix("initial_pcd_to_ply_matrix.txt", result.initialPcdToPly);
    writeMatrix("icp_refinement_pcd_to_ply_matrix.txt", result.refinementPcdToPly);
    writeMatrix("pcd_to_ply_cloudcompare_matrix.txt", pcdToPlyCloudCompare);
    writeMatrix("ply_to_pcd_cloudcompare_matrix.txt", plyToPcdCloudCompare);

    const double elapsedSeconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - started).count();
    std::ofstream output(arguments.outputDirectory / "registration.json");
    if (!output) throw std::runtime_error("Cannot create registration result file");
    output << std::fixed << std::setprecision(12)
           << "{\n"
           << "  \"status\": \"success\",\n"
           << "  \"formula\": \"p_pcd = T_ply_to_pcd * p_ply\",\n"
           << "  \"matrix_convention\": \"column_vector\",\n"
           << "  \"initial_pcd_to_ply\": ";
    writeMatrixJson(output, result.initialPcdToPly, 2);
    output << ",\n  \"icp_refinement_pcd_to_ply\": ";
    writeMatrixJson(output, result.refinementPcdToPly, 2);
    output << ",\n"
           << "  \"pcd_to_ply\": ";
    writeMatrixJson(output, result.pcdToPly, 2);
    output << ",\n  \"ply_to_pcd\": ";
    writeMatrixJson(output, result.plyToPcd, 2);
    output << ",\n  \"pcd_to_ply_cloudcompare\": ";
    writeMatrixJson(output, pcdToPlyCloudCompare, 2);
    output << ",\n  \"ply_to_pcd_cloudcompare\": ";
    writeMatrixJson(output, plyToPcdCloudCompare, 2);
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
               << ", \"final_rms\": " << candidate.finalRms << ", \"pcd_to_ply\": ";
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

int runPreview(const PreviewArguments& arguments)
{
    std::filesystem::create_directories(arguments.outputDirectory);
    const auto ply = registration::PlyReader().read(arguments.ply);
    const auto pcd = registration::PcdReader().read(arguments.pcd);
    const registration::PointCloudPreview writer;
    const auto plyPreview = writer.write(ply.cloud, arguments.plyLimit,
                                         arguments.outputDirectory / "ply-points.bin");
    const auto pcdPreview = writer.write(pcd.cloud, arguments.pcdLimit,
                                         arguments.outputDirectory / "pcd-points.bin");
    const bool gaussianAvailable = hasGaussianProperties(arguments.ply);
    std::ofstream metadata(arguments.outputDirectory / "metadata.json");
    if (!metadata) throw std::runtime_error("Cannot create preview metadata");
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
             << "  \"gaussian_available\": " << (gaussianAvailable ? "true" : "false") << ",\n";
    if (!gaussianAvailable)
        metadata << "  \"gaussian_error\": \"PLY does not contain a supported Gaussian attribute set\",\n";
    metadata << "  \"clouds\": {\n";
    writeSummary("ply", plyPreview, true);
    writeSummary("pcd", pcdPreview, false);
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
        if (command == "prepare-preview")
        {
            return runPreview(parsePreviewArguments(argc, argv));
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
        if (command == "inspect-pcd")
        {
            const auto result = registration::PcdReader().read(path);
            printCloudSummary("pcd", result.declaredPointCount, result.cloud.points.size(),
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
