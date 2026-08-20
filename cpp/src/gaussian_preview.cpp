// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/gaussian_preview.hpp"

#include <algorithm>
#include <cstdint>
#include <fstream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace registration
{
namespace
{
std::size_t scalarSize(const std::string& type)
{
    static const std::unordered_map<std::string, std::size_t> sizes{
        {"char", 1}, {"int8", 1}, {"uchar", 1}, {"uint8", 1},
        {"short", 2}, {"int16", 2}, {"ushort", 2}, {"uint16", 2},
        {"int", 4}, {"int32", 4}, {"uint", 4}, {"uint32", 4},
        {"float", 4}, {"float32", 4}, {"double", 8}, {"float64", 8}};
    const auto found = sizes.find(type);
    if (found == sizes.end()) throw std::runtime_error("Unsupported Gaussian PLY scalar type: " + type);
    return found->second;
}
} // namespace

void GaussianPreview::write(const std::filesystem::path& source,
                            const std::vector<std::size_t>& selectedIndices,
                            const std::filesystem::path& destination) const
{
    if (selectedIndices.empty()) throw std::runtime_error("Gaussian preview selection is empty");
    if (!std::is_sorted(selectedIndices.begin(), selectedIndices.end()))
        throw std::runtime_error("Gaussian preview indices must be sorted");
    std::ifstream input(source, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open Gaussian PLY: " + source.string());
    std::vector<std::string> header;
    std::string line;
    std::uint64_t vertexCount = 0;
    std::size_t recordSize = 0;
    bool inVertex = false;
    bool binaryLittleEndian = false;
    bool hasScale = false;
    bool hasRotation = false;
    bool hasOpacity = false;
    while (std::getline(input, line))
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        header.push_back(line);
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
            std::uint64_t count = 0;
            values >> name >> count;
            inVertex = name == "vertex";
            if (inVertex) vertexCount = count;
            else if (vertexCount != 0 && count != 0)
                throw std::runtime_error("Gaussian preview does not support PLY elements after vertex");
        }
        else if (keyword == "property" && inVertex)
        {
            std::string type;
            std::string name;
            values >> type >> name;
            if (type == "list") throw std::runtime_error("Gaussian preview does not support list vertex properties");
            recordSize += scalarSize(type);
            hasScale = hasScale || name == "scale_0";
            hasRotation = hasRotation || name == "rot_0";
            hasOpacity = hasOpacity || name == "opacity";
        }
        if (keyword == "end_header") break;
    }
    if (!binaryLittleEndian || vertexCount == 0 || recordSize == 0)
        throw std::runtime_error("Gaussian preview requires binary_little_endian vertex PLY");
    if (!hasScale || !hasRotation || !hasOpacity)
        throw std::runtime_error("PLY does not contain Gaussian scale, rotation and opacity attributes");
    if (selectedIndices.back() >= vertexCount)
        throw std::runtime_error("Gaussian preview index exceeds declared vertex count");

    std::ofstream output(destination, std::ios::binary);
    if (!output) throw std::runtime_error("Cannot create Gaussian preview: " + destination.string());
    for (const auto& headerLine : header)
    {
        if (headerLine.rfind("element vertex ", 0) == 0)
            output << "element vertex " << selectedIndices.size() << '\n';
        else
            output << headerLine << '\n';
    }
    std::vector<char> record(recordSize);
    std::size_t selected = 0;
    for (std::size_t index = 0; index < vertexCount && selected < selectedIndices.size(); ++index)
    {
        input.read(record.data(), static_cast<std::streamsize>(record.size()));
        if (!input) throw std::runtime_error("Gaussian PLY ended before all vertices were read");
        if (index == selectedIndices[selected])
        {
            output.write(record.data(), static_cast<std::streamsize>(record.size()));
            ++selected;
        }
    }
    if (selected != selectedIndices.size() || !output)
        throw std::runtime_error("Failed while writing Gaussian preview");
}
} // namespace registration
