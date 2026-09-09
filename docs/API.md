# 点云配准 API（v2）

旧版 v1 API 与手工配准页面已移除，不提供兼容入口。历史矩阵档案保留；历史会话中的旧任务链接在读取时转换为 v2。

## 使用流程

1. `POST /api/v2/registration-sessions` 上传 `model_a` 和 `model_b`，保存返回的 `workspace_id`。
2. 轮询会话状态，等待 `ready`，可通过业务矩阵接口更新预变换。
3. 向会话的 `/register` 接口提交粗配准矩阵、移动模型、输出方向和 ICP 参数。
4. 使用返回的 `status_url` 查询任务、`progress_url` 订阅 SSE。成功后读取 `result_url`。
5. 使用 `/api/v2/registrations/{job_id}/cancel` 取消排队或运行中的任务。已完成任务取消返回 409。

矩阵采用列向量约定。输出方向 `a_to_b`／`b_to_a` 与 ICP 移动模型 `a`／`b`／`auto` 独立。新版工作台提交 `coordinate_space=business`；业务矩阵用于业务坐标查询，`file_a_to_b`／`file_b_to_a` 用于原始文件坐标。

## 接口清单

以下清单与当前应用 OpenAPI 对齐。响应字段和在线交互调试可查看 `/openapi.json` 与 `/docs`。

| 方法 | 路径 | 参数／请求体 |
|---|---|---|
| GET | `/health` |  |
| GET | `/` |  |
| GET | `/registration/{session_id}` | session_id（必填） |
| GET | `/api/v2/registration-history` | workspace_id（必填） |
| GET | `/api/v2/registration-history/{session_id}` | session_id（必填）、workspace_id（必填） |
| PUT | `/api/v2/registration-sessions/{session_id}/business-transforms` | session_id（必填）、application/json：BusinessTransformsRequest |
| GET | `/api/v2/registration-sessions/{session_id}` | session_id（必填） |
| POST | `/api/v2/registration-sessions/{session_id}/retain` | session_id（必填）、application/json：WorkspaceRequest |
| POST | `/api/v2/registration-sessions/{session_id}/release` | session_id（必填）、application/json：WorkspaceRequest |
| POST | `/api/v2/registration-sessions/{session_id}/resume` | session_id（必填）、application/json：WorkspaceRequest |
| GET | `/api/v2/registration-sessions/{session_id}/preview/{model}` | session_id（必填）、model（必填） |
| GET | `/api/v2/registrations/{job_id}` | job_id（必填） |
| GET | `/api/v2/registrations/{job_id}/events` | job_id（必填）、from_latest |
| POST | `/api/v2/registrations/{job_id}/cancel` | job_id（必填） |
| GET | `/api/v2/registrations/{job_id}/result` | job_id（必填） |
| GET | `/api/v2/registrations/{job_id}/files/{filename}` | job_id（必填）、filename（必填） |
| POST | `/api/v2/registration-sessions/{session_id}/register` | session_id（必填）、application/json：ModelRegistrationRequest |
| POST | `/api/v2/registration-sessions` | multipart/form-data：Body_create_model_registration_session_api_v2_registration_sessions_post |

## 请求字段

下面为当前请求模型。必填字段需显式提供，默认值以接口返回的 OpenAPI 为准。

### Body_create_model_registration_session_api_v2_registration_sessions_post

| 字段 | 类型 | 必填 |
|---|---|---|
| `model_a` | string | 是 |
| `model_b` | string | 是 |
| `output_direction` | string | 否 |
| `moving_model` | string | 否 |
| `workspace_id` | string | 否 |
| `model_a_transform` | string | 否 |
| `model_b_transform` | string | 否 |

### BusinessTransformsRequest

| 字段 | 类型 | 必填 |
|---|---|---|
| `model_a` | TransformParameters | 是 |
| `model_b` | TransformParameters | 是 |

### ModelRegistrationRequest

| 字段 | 类型 | 必填 |
|---|---|---|
| `initial_moving_local_to_fixed_local` | array | 是 |
| `output_direction` | string | 否 |
| `moving_model` | string | 否 |
| `min_rms_decrease` | number | 否 |
| `sampling_limit` | integer | 否 |
| `overlap` | number | 否 |
| `random_seed` | integer | 否 |
| `show_registration_progress` | boolean | 否 |
| `coordinate_space` | string | 否 |

### TransformParameters

| 字段 | 类型 | 必填 |
|---|---|---|
| `translation` | array | 否 |
| `rotation_degrees` | array | 否 |
| `scale` | array | 否 |

### WorkspaceRequest

| 字段 | 类型 | 必填 |
|---|---|---|
| `workspace_id` | string | 是 |

## 历史与文件保留

历史按 `workspace_id` 隔离。源模型和预览默认保留 24 小时；保留、释放、恢复操作需传入所属工作区。源文件已清理时继续配准返回 409，历史矩阵仍可查询。

SSE 使用 `iteration` 和 `terminal` 事件。`from_latest=true` 从最后一条已记录迭代开始，然后跟踪新事件。

任务失败时检查 `error_code` 和 `error`。文件下载采用白名单，未知文件返回 404。旧 `/api/v1` 路径返回 404。
