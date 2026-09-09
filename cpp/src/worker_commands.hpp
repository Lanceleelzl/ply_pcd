// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "worker_arguments.hpp"

#include <filesystem>

namespace registration::worker
{
int runRegistration(const RegisterArguments& arguments);
int runModelRegistration(const ModelRegisterArguments& arguments);
int runPreview(const PreviewArguments& arguments);
int runModelPreview(const ModelPreviewArguments& arguments);
int runInspectPly(const std::filesystem::path& path);
int runInspectReference(const std::filesystem::path& path);
int runInvertMatrix(const std::filesystem::path& path);
} // namespace registration::worker
