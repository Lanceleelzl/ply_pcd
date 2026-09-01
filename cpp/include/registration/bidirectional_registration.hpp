// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include "registration/icp_registration.hpp"
#include "registration/reference_cloud_reader.hpp"

namespace registration
{
enum class MovingModel
{
    A,
    B,
    Auto,
};

struct BidirectionalRegistrationOptions
{
    MovingModel movingModel = MovingModel::Auto;
    IcpOptions icp;
};

struct BidirectionalRegistrationResult
{
    ReferenceCloudReadResult modelA;
    ReferenceCloudReadResult modelB;
    MovingModel movingModel = MovingModel::A;
    Matrix4d initialMovingLocalToFixedLocal;
    Matrix4d refinementMovingLocalToFixedLocal;
    Matrix4d movingLocalToFixedLocal;
    Matrix4d aToB;
    Matrix4d bToA;
    double scale = 1.0;
    double finalRms = -1.0;
    unsigned finalPointCount = 0;
};

class BidirectionalRegistration
{
public:
    [[nodiscard]] BidirectionalRegistrationResult registerModels(
        ReferenceCloudReadResult modelA,
        ReferenceCloudReadResult modelB,
        const BidirectionalRegistrationOptions& options = {}) const;

    [[nodiscard]] static MovingModel recommendMovingModel(
        const ReferenceCloudReadResult& modelA,
        const ReferenceCloudReadResult& modelB);
};
} // namespace registration
