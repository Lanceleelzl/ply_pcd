// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/ply_reader.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace registration
{
namespace
{
enum class PlyFormat
{
    Ascii,
    BinaryLittleEndian,
};

enum class ScalarType
{
    Int8,
    UInt8,
    Int16,
    UInt16,
    Int32,
    UInt32,
    Float32,
    Float64,
};

struct Property
{
    std::string name;
    ScalarType type;
    std::size_t offset = 0;
    std::size_t size = 0;
};

ScalarType parseType(const std::string& name)
{
    if (name == "char" || name == "int8") return ScalarType::Int8;
    if (name == "uchar" || name == "uint8") return ScalarType::UInt8;
    if (name == "short" || name == "int16") return ScalarType::Int16;
    if (name == "ushort" || name == "uint16") return ScalarType::UInt16;
    if (name == "int" || name == "int32") return ScalarType::Int32;
    if (name == "uint" || name == "uint32") return ScalarType::UInt32;
    if (name == "float" || name == "float32") return ScalarType::Float32;
    if (name == "double" || name == "float64") return ScalarType::Float64;
    throw std::runtime_error("Unsupported PLY scalar type: " + name);
}

std::size_t typeSize(ScalarType type)
{
    switch (type)
    {
    case ScalarType::Int8:
    case ScalarType::UInt8: return 1;
    case ScalarType::Int16:
    case ScalarType::UInt16: return 2;
    case ScalarType::Int32:
    case ScalarType::UInt32:
    case ScalarType::Float32: return 4;
    case ScalarType::Float64: return 8;
    }
    throw std::runtime_error("Invalid PLY scalar type");
}

template <typename T>
T readNative(const char* data)
{
    T value{};
    std::memcpy(&value, data, sizeof(T));
    return value;
}

double readScalar(const char* data, ScalarType type)
{
    switch (type)
    {
    case ScalarType::Int8: return readNative<std::int8_t>(data);
    case ScalarType::UInt8: return readNative<std::uint8_t>(data);
    case ScalarType::Int16: return readNative<std::int16_t>(data);
    case ScalarType::UInt16: return readNative<std::uint16_t>(data);
    case ScalarType::Int32: return readNative<std::int32_t>(data);
    case ScalarType::UInt32: return readNative<std::uint32_t>(data);
    case ScalarType::Float32: return readNative<float>(data);
    case ScalarType::Float64: return readNative<double>(data);
    }
    throw std::runtime_error("Invalid PLY scalar type");
}

const Property& findProperty(const std::vector<Property>& properties, std::string_view name)
{
    const auto found = std::find_if(properties.begin(), properties.end(), [&](const Property& property) {
        return property.name == name;
    });
    if (found == properties.end())
    {
        throw std::runtime_error("PLY vertex element is missing property: " + std::string(name));
    }
    return *found;
}
} // namespace

PlyReadResult PlyReader::read(const std::filesystem::path& path) const
{
    std::ifstream input(path, std::ios::binary);
    if (!input)
    {
        throw std::runtime_error("Cannot open PLY file: " + path.string());
    }

    std::string line;
    if (!std::getline(input, line) || line != "ply")
    {
        throw std::runtime_error("Invalid PLY signature");
    }

    PlyFormat format = PlyFormat::Ascii;
    bool formatSeen = false;
    bool inVertexElement = false;
    std::uint64_t vertexCount = 0;
    std::vector<Property> properties;
    std::size_t vertexStride = 0;

    while (std::getline(input, line))
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line == "end_header") break;

        std::istringstream fields(line);
        std::string keyword;
        fields >> keyword;
        if (keyword == "format")
        {
            std::string value;
            fields >> value;
            if (value == "ascii") format = PlyFormat::Ascii;
            else if (value == "binary_little_endian") format = PlyFormat::BinaryLittleEndian;
            else throw std::runtime_error("Unsupported PLY format: " + value);
            formatSeen = true;
        }
        else if (keyword == "element")
        {
            std::string name;
            std::uint64_t count = 0;
            fields >> name >> count;
            inVertexElement = name == "vertex";
            if (inVertexElement) vertexCount = count;
        }
        else if (keyword == "property" && inVertexElement)
        {
            std::string typeName;
            fields >> typeName;
            if (typeName == "list")
            {
                throw std::runtime_error("List properties are not supported in the PLY vertex element");
            }
            std::string name;
            fields >> name;
            const auto type = parseType(typeName);
            const auto size = typeSize(type);
            properties.push_back(Property{name, type, vertexStride, size});
            vertexStride += size;
        }
    }

    if (!formatSeen || vertexCount == 0 || properties.empty())
    {
        throw std::runtime_error("Incomplete PLY header");
    }
    const Property& xProperty = findProperty(properties, "x");
    const Property& yProperty = findProperty(properties, "y");
    const Property& zProperty = findProperty(properties, "z");

    PlyReadResult result;
    result.declaredVertexCount = vertexCount;
    result.cloud.points.reserve(static_cast<std::size_t>(vertexCount));

    if (format == PlyFormat::BinaryLittleEndian)
    {
        std::vector<char> record(vertexStride);
        for (std::uint64_t index = 0; index < vertexCount; ++index)
        {
            input.read(record.data(), static_cast<std::streamsize>(record.size()));
            if (!input)
            {
                throw std::runtime_error("PLY file ended before all vertices were read");
            }
            const double x = readScalar(record.data() + xProperty.offset, xProperty.type);
            const double y = readScalar(record.data() + yProperty.offset, yProperty.type);
            const double z = readScalar(record.data() + zProperty.offset, zProperty.type);
            if (std::isfinite(x) && std::isfinite(y) && std::isfinite(z))
            {
                result.cloud.points.push_back({static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)});
            }
            else
            {
                ++result.invalidPointCount;
            }
        }
    }
    else
    {
        for (std::uint64_t index = 0; index < vertexCount; ++index)
        {
            if (!std::getline(input, line))
            {
                throw std::runtime_error("PLY file ended before all vertices were read");
            }
            std::istringstream values(line);
            double x = 0.0;
            double y = 0.0;
            double z = 0.0;
            for (const auto& property : properties)
            {
                double value = 0.0;
                if (!(values >> value)) throw std::runtime_error("Invalid ASCII PLY vertex record");
                if (property.name == "x") x = value;
                else if (property.name == "y") y = value;
                else if (property.name == "z") z = value;
            }
            if (std::isfinite(x) && std::isfinite(y) && std::isfinite(z))
                result.cloud.points.push_back({static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)});
            else
                ++result.invalidPointCount;
        }
    }
    return result;
}
} // namespace registration
