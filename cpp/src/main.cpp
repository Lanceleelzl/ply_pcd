// SPDX-License-Identifier: GPL-3.0-or-later
#include "worker_arguments.hpp"
#include "worker_commands.hpp"

#include <exception>
#include <filesystem>
#include <iostream>
#include <string>

int main(int argc, char** argv)
{
    try
    {
        if (argc < 2)
        {
            registration::worker::printUsage();
            return 10;
        }
        const std::string command = argv[1];
        if (command == "register")
        {
            return registration::worker::runRegistration(
                registration::worker::parseRegisterArguments(argc, argv));
        }
        if (command == "register-models")
        {
            return registration::worker::runModelRegistration(
                registration::worker::parseModelRegisterArguments(argc, argv));
        }
        if (command == "prepare-preview")
        {
            return registration::worker::runPreview(
                registration::worker::parsePreviewArguments(argc, argv));
        }
        if (command == "prepare-model-preview")
        {
            return registration::worker::runModelPreview(
                registration::worker::parseModelPreviewArguments(argc, argv));
        }

        if (argc != 3)
        {
            registration::worker::printUsage();
            return 10;
        }
        const std::filesystem::path path = argv[2];
        if (command == "inspect-ply")
            return registration::worker::runInspectPly(path);
        if (command == "inspect-pcd" || command == "inspect-reference")
            return registration::worker::runInspectReference(path);
        if (command == "invert-matrix")
            return registration::worker::runInvertMatrix(path);
        registration::worker::printUsage();
        return 10;
    }
    catch (const std::exception& error)
    {
        std::cerr << "registration_worker: " << error.what() << '\n';
        return 50;
    }
}
