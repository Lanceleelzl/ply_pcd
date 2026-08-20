// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/icp_registration.hpp"
#include "registration/matrix.hpp"
#include "registration/pcd_reader.hpp"
#include "registration/ply_reader.hpp"

#include <filesystem>
#include <fstream>
#include <chrono>
#include <cstdlib>
#include <iomanip>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>

namespace
{
void printUsage()
{
    std::cout
        << "Usage:\n"
        << "  registration_worker inspect-ply <file.ply>\n"
        << "  registration_worker inspect-pcd <file.pcd>\n"
        << "  registration_worker invert-matrix <matrix.txt>\n"
        << "  registration_worker register --ply <model.ply> --pcd <data.pcd> --output-dir <dir> [options]\n\n"
        << "Register options:\n"
        << "  --min-rms-decrease <value>  Default: 1e-5\n"
        << "  --max-iterations <count>     Default: RMS convergence\n"
        << "  --sampling-limit <count>     Default: 50000\n"
        << "  --overlap <0..1>             Default: 1.0\n"
        << "  --random-seed <count>        Default: 42\n"
        << "  --max-threads <count>        Default: 0\n"
        << "  --adjust-scale               Default: disabled\n"
        << "  --filter-farthest            Default: disabled\n";
}

struct RegisterArguments
{
    std::filesystem::path ply;
    std::filesystem::path pcd;
    std::filesystem::path outputDirectory;
    registration::IcpOptions options;
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
        else throw std::runtime_error("Unknown register option: " + option);
    }
    if (result.ply.empty() || result.pcd.empty() || result.outputDirectory.empty())
        throw std::runtime_error("register requires --ply, --pcd and --output-dir");
    if (result.options.samplingLimit < 3) throw std::runtime_error("sampling-limit must be at least 3");
    if (result.options.minRmsDecrease <= 0.0) throw std::runtime_error("min-rms-decrease must be positive");
    return result;
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
    const auto result = registration::IcpRegistration().registerPcdToPly(pcd.cloud, ply.cloud, arguments.options);
    const auto pcdToPlyCloudCompare = result.pcdToPly.toFloatCompatible();
    const auto plyToPcdCloudCompare = result.plyToPcd.toFloatCompatible();

    const auto writeMatrix = [&](const std::string& name, const registration::Matrix4d& matrix) {
        std::ofstream output(arguments.outputDirectory / name);
        if (!output) throw std::runtime_error("Cannot create matrix file: " + name);
        output << matrix.toString();
    };
    writeMatrix("pcd_to_ply_matrix.txt", result.pcdToPly);
    writeMatrix("ply_to_pcd_matrix.txt", result.plyToPcd);
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
           << "  }\n"
           << "}\n";
    log << "stage=complete final_rms=" << result.finalRms
        << " final_point_count=" << result.finalPointCount
        << " elapsed_seconds=" << elapsedSeconds << '\n';
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
