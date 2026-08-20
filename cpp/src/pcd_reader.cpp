// SPDX-License-Identifier: GPL-3.0-or-later
#include "registration/pcd_reader.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <numeric>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace registration
{
namespace
{
struct Field
{
    std::string name;
    std::size_t size = 0;
    char type = 0;
    std::size_t count = 1;
    std::size_t offset = 0;
};

struct Header
{
    std::vector<Field> fields;
    std::uint64_t points = 0;
    std::size_t pointStep = 0;
    std::string data;
};

std::vector<std::string> splitValues(const std::string& line)
{
    std::istringstream input(line);
    std::string ignored;
    input >> ignored;
    std::vector<std::string> values;
    for (std::string value; input >> value;) values.push_back(value);
    return values;
}

template <typename T>
T readNative(const char* data)
{
    T value{};
    std::memcpy(&value, data, sizeof(T));
    return value;
}

double readBinaryValue(const char* data, const Field& field)
{
    if (field.type == 'F' && field.size == 4) return readNative<float>(data);
    if (field.type == 'F' && field.size == 8) return readNative<double>(data);
    if (field.type == 'I' && field.size == 1) return readNative<std::int8_t>(data);
    if (field.type == 'I' && field.size == 2) return readNative<std::int16_t>(data);
    if (field.type == 'I' && field.size == 4) return readNative<std::int32_t>(data);
    if (field.type == 'I' && field.size == 8) return static_cast<double>(readNative<std::int64_t>(data));
    if (field.type == 'U' && field.size == 1) return readNative<std::uint8_t>(data);
    if (field.type == 'U' && field.size == 2) return readNative<std::uint16_t>(data);
    if (field.type == 'U' && field.size == 4) return readNative<std::uint32_t>(data);
    if (field.type == 'U' && field.size == 8) return static_cast<double>(readNative<std::uint64_t>(data));
    throw std::runtime_error("Unsupported PCD field type or size");
}

const Field& findField(const Header& header, std::string_view name)
{
    const auto found = std::find_if(header.fields.begin(), header.fields.end(), [&](const Field& field) {
        return field.name == name;
    });
    if (found == header.fields.end()) throw std::runtime_error("PCD is missing field: " + std::string(name));
    if (found->count != 1) throw std::runtime_error("PCD coordinate fields must have COUNT 1");
    return *found;
}

Header readHeader(std::istream& input)
{
    Header header;
    std::vector<std::string> fieldNames;
    std::vector<std::size_t> sizes;
    std::vector<char> types;
    std::vector<std::size_t> counts;
    std::uint64_t width = 0;
    std::uint64_t height = 1;
    std::string line;

    while (std::getline(input, line))
    {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (line.empty() || line.front() == '#') continue;
        std::istringstream fields(line);
        std::string keyword;
        fields >> keyword;
        if (keyword == "FIELDS") fieldNames = splitValues(line);
        else if (keyword == "SIZE")
        {
            for (const auto& value : splitValues(line)) sizes.push_back(static_cast<std::size_t>(std::stoul(value)));
        }
        else if (keyword == "TYPE")
        {
            for (const auto& value : splitValues(line)) types.push_back(value.at(0));
        }
        else if (keyword == "COUNT")
        {
            for (const auto& value : splitValues(line)) counts.push_back(static_cast<std::size_t>(std::stoul(value)));
        }
        else if (keyword == "WIDTH") fields >> width;
        else if (keyword == "HEIGHT") fields >> height;
        else if (keyword == "POINTS") fields >> header.points;
        else if (keyword == "DATA")
        {
            fields >> header.data;
            break;
        }
    }

    if (fieldNames.empty() || sizes.size() != fieldNames.size() || types.size() != fieldNames.size())
        throw std::runtime_error("Incomplete PCD field definition");
    if (counts.empty()) counts.assign(fieldNames.size(), 1);
    if (counts.size() != fieldNames.size()) throw std::runtime_error("PCD COUNT length mismatch");
    if (header.points == 0) header.points = width * height;
    if (header.points == 0 || header.data.empty()) throw std::runtime_error("Incomplete PCD header");
    if (header.data == "binary_compressed") throw std::runtime_error("PCD binary_compressed is not supported yet");
    if (header.data != "binary" && header.data != "ascii") throw std::runtime_error("Unsupported PCD DATA mode");

    std::size_t offset = 0;
    for (std::size_t index = 0; index < fieldNames.size(); ++index)
    {
        header.fields.push_back(Field{fieldNames[index], sizes[index], types[index], counts[index], offset});
        offset += sizes[index] * counts[index];
    }
    header.pointStep = offset;
    return header;
}
} // namespace

PcdReadResult PcdReader::read(const std::filesystem::path& path) const
{
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open PCD file: " + path.string());

    const Header header = readHeader(input);
    const Field& xField = findField(header, "x");
    const Field& yField = findField(header, "y");
    const Field& zField = findField(header, "z");

    PcdReadResult result;
    result.declaredPointCount = header.points;
    result.cloud.points.reserve(static_cast<std::size_t>(header.points));

    if (header.data == "binary")
    {
        std::vector<char> record(header.pointStep);
        for (std::uint64_t index = 0; index < header.points; ++index)
        {
            input.read(record.data(), static_cast<std::streamsize>(record.size()));
            if (!input) throw std::runtime_error("PCD file ended before all points were read");
            const double x = readBinaryValue(record.data() + xField.offset, xField);
            const double y = readBinaryValue(record.data() + yField.offset, yField);
            const double z = readBinaryValue(record.data() + zField.offset, zField);
            if (std::isfinite(x) && std::isfinite(y) && std::isfinite(z))
                result.cloud.points.push_back({static_cast<float>(x), static_cast<float>(y), static_cast<float>(z)});
            else
                ++result.invalidPointCount;
        }
    }
    else
    {
        std::string line;
        for (std::uint64_t index = 0; index < header.points; ++index)
        {
            if (!std::getline(input, line)) throw std::runtime_error("PCD file ended before all points were read");
            std::istringstream values(line);
            double x = 0.0;
            double y = 0.0;
            double z = 0.0;
            for (const auto& field : header.fields)
            {
                for (std::size_t component = 0; component < field.count; ++component)
                {
                    double value = 0.0;
                    if (!(values >> value)) throw std::runtime_error("Invalid ASCII PCD point record");
                    if (component == 0 && field.name == "x") x = value;
                    else if (component == 0 && field.name == "y") y = value;
                    else if (component == 0 && field.name == "z") z = value;
                }
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
