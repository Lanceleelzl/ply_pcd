# 高斯视界 API（v2）

旧版 v1 API 与手工配准页面已移除，不提供兼容入口。历史矩阵档案保留；历史会话中的旧任务链接在读取时转换为 v2。

## 使用流程

1. `POST /api/v2/registration-sessions` 为 A／B 各上传一个单文件或一组目录文件，保存返回的 `workspace_id`。
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
| POST | `/api/v2/streaming-tasks` | multipart/form-data：input_kind、workspace_id、business_transform、file 或 files |
| GET | `/api/v2/streaming-tasks` | workspace_id（必填） |
| GET | `/api/v2/streaming-tasks/{task_id}` | task_id（必填） |
| PUT | `/api/v2/streaming-tasks/{task_id}/business-transform` | TransformParameters |
| POST | `/api/v2/streaming-tasks/{task_id}/coordinate-query` | 场景点、轴映射、参考点、独立及投影原点、单位、源／目标 EPSG |
| POST | `/api/v2/streaming-tasks/{task_id}/coordinate-origin` | WGS84 经度、纬度和目标投影 source_epsg |
| POST | `/api/v2/streaming-tasks/{task_id}/generate` | task_id（必填） |
| POST | `/api/v2/streaming-tasks/{task_id}/retain` | task_id（必填） |
| POST | `/api/v2/streaming-tasks/{task_id}/release` | task_id（必填） |
| GET | `/api/v2/streaming-tasks/{task_id}/preview` | task_id（必填） |
| GET | `/api/v2/streaming-tasks/{task_id}/download` | task_id（必填） |

## 请求字段

下面为当前请求模型。必填字段需显式提供，默认值以接口返回的 OpenAPI 为准。

### Body_create_model_registration_session_api_v2_registration_sessions_post

| 字段 | 类型 | 必填 |
|---|---|---|
| `model_a` | binary | 条件必填 |
| `model_b` | binary | 条件必填 |
| `model_a_files` | array<binary> | 条件必填 |
| `model_b_files` | array<binary> | 条件必填 |
| `output_direction` | string | 否 |
| `moving_model` | string | 否 |
| `workspace_id` | string | 否 |
| `model_a_transform` | string | 否 |
| `model_b_transform` | string | 否 |

每个模型必须在单文件字段和目录字段之间二选一：A 使用 `model_a` 或重复的 `model_a_files`，B 使用 `model_b` 或重复的 `model_b_files`。目录 part 的 filename 必须保留从所选根目录开始的相对路径。支持格式、目录入口、版本白名单和安全限制见 [DATA_FORMAT_COMPATIBILITY.md](DATA_FORMAT_COMPATIBILITY.md) 。

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

## 独立流式任务

`POST /api/v2/streaming-tasks` 使用 multipart。`input_kind=single` 时传一个 `file`；`dataset` 传一个 ZIP `file` 或重复的目录 `files`，每个 filename 保留相对路径；`lod_group` 传至少两个重复 `files`，顺序就是 LOD 0、LOD 1……，LOD 0 最精细。`business_transform` 是可选的 TransformParameters JSON 字符串。

任务的 `status` 独立表示预览准备，`cache_status` 独立表示生成状态。详情返回 `preview_url`、原始 `gaussian_url`、生成完成后的 `cache_url`、元数据、业务矩阵和 LOD 清单。业务矩阵只用于显示与坐标查询，不写入 Streamed SOG；剖切也只影响浏览器预览。

调用 `/generate` 后轮询详情，直到 `cache_status=ready` 或 `failed`。`/download` 以流式 ZIP 返回输出目录，并附带逐文件 SHA-256 清单；响应头 `X-Cache-File-Count` 和 `X-Cache-Source-Bytes` 用于显示下载信息。

源文件、计算文件与预览默认保留配置指定的小时数。`/retain` 从当前时间重新延长一个保留周期；`/release` 立即释放这些数据并保留已经生成的输出。后台清理和主动释放都会跳过正在准备、生成或下载的任务。

## 历史与文件保留

### 流式坐标查询

界面定位参考点默认模型原点，也支持选取已知场景点；内部逆业务矩阵绑定其原始模型位置作为 `reference`。参考点输入 WGS84 时先调用 `/coordinate-origin` 得到投影坐标，再调用查询接口；没有指定源 EPSG 时根据经纬度选 WGS84 UTM（纬度范围 −80°～84°），有源 EPSG 则沿用。原始模型轴向与显示矩阵独立，场景方向由两者推导。查询浮窗仅显示场景 XYZ、WGS84 经纬度和高度，接口 `projected` 保留内部投影计算结果。

`/coordinate-query` 接收 `point`、`reference`、`independent_origin`、`projected_origin` 三元素数组。`point` 与 `reference` 为模型原始文件坐标，浏览器先将场景查询点按业务矩阵逆变换；`axes` 为文件东／北／上对应的有符号轴编号（X＝1、Y＝2、Z＝3），三条轴不得重复。`metres_per_unit` 为文件单位到米的倍率，`source_epsg` 必须为投影坐标系，`target_epsg` 仅支持 4326（默认）。先减文件参考点，再按轴向与单位计算偏移；独立原点以米表示，投影原点 E／N 使用源投影单位，H 使用米。返回轴向映射后的独立坐标、投影坐标、经度、纬度、源坐标系名称、转换精度及近似转换标识；界面的原始／独立 XYZ 单独显示业务矩阵反算值。高度只叠加偏移，不执行高程基准转换。接口沿用任务鉴权，非法设置返回 422。

`GET /api/v2/streaming-tasks/{task_id}/coordinate-metadata` 返回原始 PLY 头部的 `source`、`epsg`、`offset`、`shift`、`scale`。数字注释以原字符串返回，三元素数组的缺失／无效项为 null，非 PLY 返回空信息。头部读取限制为 1 MiB，不读取顶点数据；新任务在准备时保存信息，旧任务按需读取尚保留的原始文件，不使用转换生成的 PLY 猜测坐标基准。非默认 shift／scale 只提示核对，不自动应用未经确认的厂商约定。

`/coordinate-origin` 接收 `source_epsg`、`longitude`、`latitude`，将 WGS84 坐标转换为源投影 E／N，返回 `east`、`north`、`source_name` 和按 E／N 顺序排列的 `metres_per_projected_unit` 单位倍率。查询结果中的经纬度和高度可编辑；浏览器用同一定位参考点、源 EPSG、轴向和文件单位还原原始模型位置，再应用业务矩阵更新场景坐标与查询点手柄。场景坐标变化自动正算，不提供刷新按钮。浏览器坐标设置按任务保存在本机，不写入模型及生成成果。实现参考 [pyproj Transformer 文档](https://pyproj4.github.io/pyproj/stable/api/transformer.html) 。

历史按 `workspace_id` 隔离。源模型和预览默认保留 24 小时；保留、释放、恢复操作需传入所属工作区。源文件已清理时继续配准返回 409，历史矩阵仍可查询。

SSE 使用 `iteration` 和 `terminal` 事件。`from_latest=true` 从最后一条已记录迭代开始，然后跟踪新事件。

任务失败时检查 `error_code` 和 `error`。文件下载采用白名单，未知文件返回 404。旧 `/api/v1` 路径返回 404。
