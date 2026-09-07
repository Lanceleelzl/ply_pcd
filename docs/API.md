# 通用点云双向 Registration Service API

## 1．文档信息

| 项目 | 内容 |
|---|---|
| API 名称 | PLY／PCD Registration Service API |
| API 版本 | `v2`（推荐）／`v1`（兼容） |
| 服务版本 | `0.3.0` |
| 协议 | HTTP／JSON／multipart/form-data |
| 本地 Base URL | `http://localhost:8765` |
| OpenAPI | `/openapi.json` |
| Swagger UI | `/docs` |
| 认证 | 当前版本未启用，禁止直接暴露到公网 |

## 2．业务说明

服务接收 Gaussian Splatting PLY 模型和无人机 SLAM PCD 点云，使用 PCD 作为移动点云、PLY 作为固定点云执行 ICP，然后返回双向坐标转换矩阵。

人工粗配准流程先创建会话并生成轻量预览，浏览器只允许移动 PCD。提交的 `initial_pcd_to_ply` 先作用于原始 PCD，ICP 返回增量矩阵，最终计算 `T_pcd_to_ply = T_icp_delta × T_manual_pcd_to_ply`。

业务系统最终应使用：

```text
T_ply_to_pcd
```

矩阵公式和约定：

```text
p_pcd = T_ply_to_pcd × p_ply
```

- 使用 `4×4` 齐次矩阵。
- 使用列向量约定。
- 点坐标齐次形式为 `[x, y, z, 1]ᵀ`。
- Java、Python 和前端优先读取 `recommended_matrix.value`。
- CloudCompare 手工验证读取 `recommended_matrix.cloudcompare_value`。

## 3．任务流程

```text
上传 PLY＋PCD
    ↓
POST 创建任务，返回 job_id
    ↓
GET 轮询 queued／running
    ↓
succeeded → GET result
failed    → 读取 error_code 和 error
```

创建任务接口只等待文件上传完成，不等待 ICP 完成。客户端建议每 1～2 秒查询一次状态。

## 4．任务状态

| 状态 | 说明 | 是否终态 |
|---|---|---|
| `queued` | 文件上传完成，等待执行 | 否 |
| `running` | C++ Worker 正在配准 | 否 |
| `succeeded` | 配准完成，可以读取结果 | 是 |
| `failed` | 参数、文件解析、Worker 或 ICP 失败 | 是 |
| `cancelled` | 用户主动终止，Worker 已结束，可重新提交 | 是 |

## 5．接口列表

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/v1/registrations` | 上传文件并创建配准任务 |
| `GET` | `/api/v1/registrations/{job_id}` | 查询任务状态 |
| `POST` | `/api/v1/registrations/{job_id}/cancel` | 终止 queued／running 配准任务 |
| `GET` | `/api/v1/registrations/{job_id}/result` | 获取配准结果 |
| `GET` | `/api/v1/registrations/{job_id}/files/{filename}` | 下载结果文件 |

## 6．健康检查

### `GET /health`

成功响应：`200 OK`

```json
{
  "status": "ok"
}
```

该接口只表示 HTTP 进程正常，不执行 PLY／PCD 解析或 ICP 自检。

## 7．创建配准任务

### `POST /api/v1/registrations`

请求类型：

```http
Content-Type: multipart/form-data
```

### 7.1 表单参数

| 参数 | 类型 | 必填 | 默认值 | 约束 | 说明 |
|---|---|---|---|---|---|
| `ply` | binary | 是 | — | 文件名以 `.ply` 结尾，非空 | Gaussian PLY 模型 |
| `pcd` | binary | 是 | — | 文件名以 `.pcd`、`.las` 或 `.laz` 结尾，非空 | SLAM 定位参考点云；字段名为向后兼容保留 |
| `min_rms_decrease` | number | 否 | `0.00001` | `1e-8 <= value <= 1e-3` | RMS 收敛阈值，不是最终误差目标 |
| `sampling_limit` | integer | 否 | `50000` | `10000 <= value <= 500000` | ICP 最大采样点数；`50000` 是 CloudCompare 默认值，本项目已进行复现验证 |
| `overlap` | number | 否 | `1.0` | `0.5 <= value <= 1` | PCD 中预计有效匹配点比例；默认值已通过 CloudCompare 手工验证 |
| `random_seed` | integer | 否 | `42` | `0 <= value <= 4294967295` | 随机采样种子，用于结果复现 |
| `precision_mode` | string | 否 | `recommended` | `recommended` 或 `high_accuracy` | 推荐模式为单阶段 CloudCompare 默认参数基线；高采样模式追加三次重复性验证 |

不要手工设置 multipart 的 `boundary`；浏览器、Java HTTP 客户端或 HTTP 库应自动生成。

### 7.2 cURL 示例

```bash
curl -X POST "http://localhost:8765/api/v1/registrations" \
  -F "ply=@point_cloud.ply" \
  -F "pcd=@GlobalMap.pcd" \
  -F "min_rms_decrease=0.00001" \
  -F "sampling_limit=50000" \
  -F "overlap=1.0" \
  -F "random_seed=42"
```

### 7.3 成功响应

状态码：`202 Accepted`

```json
{
  "job_id": "69985db2-9b40-44f4-bc53-b67888148a21",
  "status": "queued",
  "status_url": "/api/v1/registrations/69985db2-9b40-44f4-bc53-b67888148a21"
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `job_id` | string／UUID | 任务唯一标识 |
| `status` | string | 创建时为 `queued` |
| `status_url` | string | 相对状态查询地址 |

### 7.4 请求错误

状态码：`400 Bad Request`

```json
{
  "detail": "ply file must use .ply extension"
}
```

FastAPI 表单字段类型校验失败时返回 `422 Unprocessable Entity`。

## 8．查询任务状态

### `GET /api/v1/registrations/{job_id}`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `job_id` | string／UUID | 创建任务时返回的任务 ID |

运行中响应：`200 OK`

```json
{
  "job_id": "69985db2-9b40-44f4-bc53-b67888148a21",
  "status": "running",
  "created_at_unix": 1787187461.5081284,
  "started_at_unix": 1787187461.5270944,
  "updated_at_unix": 1787187461.5270944,
  "inputs": {
    "ply_bytes": 256898154,
    "pcd_bytes": 4778395
  }
}
```

成功响应：`200 OK`

```json
{
  "job_id": "69985db2-9b40-44f4-bc53-b67888148a21",
  "status": "succeeded",
  "result_url": "/api/v1/registrations/69985db2-9b40-44f4-bc53-b67888148a21/result",
  "finished_at_unix": 1787187506.5889523
}
```

失败响应仍使用 `200 OK`，任务状态为 `failed`：

```json
{
  "job_id": "93aa6bcf-6178-4f9b-ada8-f38f4098f24e",
  "status": "failed",
  "error_code": "worker_failed",
  "worker_exit_code": 50,
  "error": "registration_worker: Invalid PLY signature"
}
```

客户端必须根据 `status` 判断业务结果，不能仅根据 HTTP `200` 判断配准成功。

任务不存在或 `job_id` 不是合法 UUID 时返回 `404 Not Found`。

## 9．获取配准结果

### `GET /api/v1/registrations/{job_id}/result`

仅当任务状态为 `succeeded` 时调用。

成功响应：`200 OK`。以下为重点字段节选，实际响应还包含四个完整方向矩阵和全部运行参数。

```json
{
  "recommended_matrix": {
    "name": "T_ply_to_reference",
    "direction": "PLY_TO_REFERENCE_WORLD",
    "formula": "p_reference_world = T_ply_to_reference * p_ply",
    "usage": "Use this matrix to transform Gaussian PLY points into the SLAM PCD coordinate system.",
    "value": [
      [0.770525392783, 0.636229039115, -0.038771495496, 2.007133790958],
      [-0.636975769529, 0.770818583546, -0.010028972673, 1.799730135236],
      [0.023505065593, 0.032424081287, 0.999197773638, -0.111517309364],
      [0, 0, 0, 1]
    ],
    "cloudcompare_value": [
      [0.77052539587, 0.636229038239, -0.038771495223, 2.007133722305],
      [-0.636975765228, 0.770818591118, -0.01002897229, 1.799730181694],
      [0.02350506559, 0.032424081117, 0.999197781086, -0.111517310143],
      [0, 0, 0, 1]
    ]
  },
  "status": "success",
  "formula": "p_pcd = T_ply_to_pcd * p_ply",
  "matrix_convention": "column_vector",
  "metrics": {
    "final_rms": 0.181048963806,
    "final_point_count": 50000,
    "scale": 1,
    "elapsed_seconds": 21.009938441
  }
}
```

### 9.1 结果字段

| 字段 | 类型 | 用途 |
|---|---|---|
| `recommended_matrix.value` | number[4][4] | 最终业务使用的高精度 PLY→定位参考点云世界坐标矩阵 |
| `reference_format` | string | `pcd`、`las` 或 `laz` |
| `reference_origin` | number[3] | LAS／LAZ 局部化使用的双精度世界原点；PCD 为零 |
| `ply_to_reference` | number[4][4] | 最终业务矩阵，已经恢复 LAS／LAZ 世界原点 |
| `reference_to_ply` | number[4][4] | 世界参考坐标到 PLY 的反向矩阵 |
| `reference_local_to_ply` | number[4][4] | 仅供三维预览恢复姿态的局部矩阵，不用于航点转换 |
| `recommended_matrix.cloudcompare_value` | number[4][4] | CloudCompare 手工验证使用的 float32 兼容矩阵 |
| `ply_to_pcd` | number[4][4] | 与推荐高精度矩阵相同 |
| `pcd_to_ply` | number[4][4] | ICP 直接计算的反方向矩阵 |
| `metrics.final_rms` | number | 最终 RMS，越小通常表示最近邻残差越小 |
| `metrics.final_point_count` | integer | 最终参与计算的点数 |
| `metrics.elapsed_seconds` | number | Worker 处理耗时，不含网络上传时间 |
| `parameters` | object | 本次任务实际使用的参数 |

任务尚未成功时调用结果接口返回 `409 Conflict`：

```json
{
  "detail": "Job status is running"
}
```

## 10．下载结果文件

### `GET /api/v1/registrations/{job_id}/files/{filename}`

允许下载：

| 文件名 | 说明 |
|---|---|
| `registration.json` | C++ Worker 原始完整结果 |
| `ply_to_pcd_matrix.txt` | 高精度 PLY→PCD 矩阵 |
| `pcd_to_ply_matrix.txt` | 高精度 PCD→PLY 矩阵 |
| `ply_to_pcd_cloudcompare_matrix.txt` | CloudCompare 兼容 PLY→PCD 矩阵 |
| `pcd_to_ply_cloudcompare_matrix.txt` | CloudCompare 兼容 PCD→PLY 矩阵 |
| `registration.log` | Worker 配准日志 |

业务系统通常直接读取结果 JSON。需要保存矩阵或导入其他工具时，再下载文本文件。

## 11．错误码

| HTTP 状态码 | 场景 |
|---|---|
| `200` | 查询成功；任务失败也通过响应体中的 `status=failed` 表示 |
| `202` | 配准任务已接收 |
| `400` | 文件扩展名、空文件或配准参数无效 |
| `404` | 任务或结果文件不存在，或结果已过期清理 |
| `409` | 任务尚未成功，暂时不能读取结果 |
| `422` | multipart 字段缺失或字段类型不合法 |
| `500` | 未处理的服务端错误 |

任务级 `error_code`：

| `error_code` | 说明 |
|---|---|
| `worker_timeout` | Worker 超过配置的最长执行时间 |
| `worker_failed` | Worker 启动成功，但解析或配准失败 |
| `worker_start_failed` | Worker 子进程无法启动 |
| `missing_result` | Worker 返回成功，但没有生成结果文件 |

## 12．前端调用示例

```javascript
export async function registerPlyToPcd(baseUrl, plyFile, pcdFile) {
  const form = new FormData();
  form.append("ply", plyFile);
  form.append("pcd", pcdFile);
  form.append("random_seed", "42");

  const createdResponse = await fetch(`${baseUrl}/api/v1/registrations`, {
    method: "POST",
    body: form
  });
  if (!createdResponse.ok) throw new Error(await createdResponse.text());
  const created = await createdResponse.json();

  while (true) {
    const statusResponse = await fetch(`${baseUrl}${created.status_url}`);
    if (!statusResponse.ok) throw new Error(await statusResponse.text());
    const status = await statusResponse.json();

    if (status.status === "succeeded") {
      const resultResponse = await fetch(`${baseUrl}${status.result_url}`);
      if (!resultResponse.ok) throw new Error(await resultResponse.text());
      const result = await resultResponse.json();
      return result.recommended_matrix.value;
    }
    if (status.status === "failed") throw new Error(status.error);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
```

浏览器页面与 API 跨域时需要在服务端配置允许的 CORS Origin。生产环境建议通过同域反向代理访问。

## 13．Java／Python 示例

- Java 11＋：`examples/RegistrationClient.java`
- Python：`examples/python_client.py`

两个示例均执行上传、状态轮询和结果读取。Java 示例使用 JDK HTTP Client；Python 示例使用 `requests`。

## 14．文件保留与并发

- 普通单次配准上传的 PLY／PCD 副本在任务成功或失败后立即删除。
- 人工配准会话的原始 PLY／PCD 保留到会话过期，以支持同一会话多轮 ICP；各轮任务不会复制大体积点云。
- 结果、矩阵和日志默认保留 `168` 小时。
- 默认每 `3600` 秒检查一次过期任务。
- 默认同时运行 `1` 个 ICP 任务，其他任务保持 `queued`。
- 默认 Worker 超时为 `1800` 秒。
- 清理范围仅限服务管理的 `runtime/jobs/{UUID}`。
- 原始 `source` 目录不会被 API 清理。

相关环境变量：

```text
REGISTRATION_MAX_CONCURRENT_JOBS
REGISTRATION_WORKER_TIMEOUT_SECONDS
REGISTRATION_RESULT_RETENTION_HOURS
REGISTRATION_CLEANUP_INTERVAL_SECONDS
REGISTRATION_SOURCE_RETENTION_HOURS
```

## 15．生产部署注意事项

当前 `v1` 是单机 MVP。对外提供服务前至少应增加：

- HTTPS 和反向代理。
- 身份认证与调用权限。
- 上传文件大小限制。
- 明确的 CORS Origin 白名单。
- 磁盘容量与任务失败监控。
- 多实例场景下的持久化任务队列和共享对象存储。

## 16．人工粗配准接口

### 创建会话

```http
POST /api/v1/manual-registration-sessions
Content-Type: multipart/form-data
```

上传字段仍为 `ply` 和 `pcd`，其中 `pcd` 是为兼容既有调用保留的字段名，内容支持 PCD、LAS 或 LAZ。服务保存原始文件并异步生成体素采样预览，返回 `session_id`、`status_url` 和兼容字段 `editor_url`。Web 前端使用 `/?session={session_id}` 在主页内打开统一配准工作台；API 调用方不需要依赖页面地址。

### 查询会话

```http
GET /api/v1/manual-registration-sessions/{session_id}
```

状态为 `ready` 后返回 `ply_preview_url`、`pcd_preview_url`、点数和包围盒。Gaussian 属性可用时还返回 `gaussian_preview_url`；该资源指向会话中保存的原始 PLY，只有用户切换完整 Gaussian 显示时才流式下载。执行过 ICP 后，响应还包含 `registrations` 历史数组和当前 `active_job_id`；每条记录保存任务状态、实际参数、提交时的绝对 `initial_pcd_to_ply` 以及成功后的 `result_url`。

### 获取预览

```http
GET /api/v1/manual-registration-sessions/{session_id}/preview/ply
GET /api/v1/manual-registration-sessions/{session_id}/preview/reference
GET /api/v1/manual-registration-sessions/{session_id}/preview/gaussian
```

`ply` 和 `reference` 使用项目内部 `PCPV0001` 二进制点云格式；兼容地址 `preview/pcd` 仍可用。`gaussian` 返回未经抽样的原始 binary little-endian Gaussian PLY，可能占用较高网络带宽和 GPU 显存。

### 提交初始矩阵并精配准

```http
POST /api/v1/manual-registration-sessions/{session_id}/register
Content-Type: application/json
```

```json
{
  "initial_pcd_to_ply": [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ],
  "precision_mode": "high_accuracy",
  "min_rms_decrease": 0.00001,
  "sampling_limit": 50000,
  "overlap": 1.0,
  "random_seed": 42
}
```

`high_accuracy` 先使用请求中的 `sampling_limit` 和 `random_seed` 得到基线矩阵，再以该矩阵为初值、`500000` 点上限和三个连续种子执行精配准。结果的 `precision` 字段返回：

```text
mode
high_accuracy_sampling_limit
stability_runs
translation_stability_m
rotation_stability_deg
translation_threshold_m
rotation_threshold_deg
stable
candidates
```

默认稳定阈值为平移 `0.02 m`、旋转 `0.2°`。`stable=true` 只表示多次 ICP 结果稳定，不能替代独立控制点或实飞误差验证。

初始矩阵必须是有限、无缩放、正交且行列式接近 `+1` 的刚体 `4×4` 矩阵，最后一行必须为 `[0, 0, 0, 1]`。接口返回标准异步配准任务，结果新增：

```text
initial_pcd_to_ply
icp_refinement_pcd_to_ply
pcd_to_ply
ply_to_pcd
```

人工会话与任务结果使用相同的默认 `168` 小时保留期限。

同一人工会话同一时间只允许一个 `queued／running` ICP 任务；重复提交返回 `409`。任务结束后可以继续移动 PCD、切换模式或修改参数并再次调用本接口。每轮都重新读取会话中的原始 PLY／PCD，不在上一轮已变换点坐标上重复累积变换。

Web 工作台会在提交时读取当前 PCD 绝对变换作为 `initial_pcd_to_ply`。精配准完成后，三维视口显示最终 `PCD→PLY` 对齐效果，同时恢复粗配准和参数控件。页面保留多轮历史；若结果完成后又改变当前姿态或参数，上一次 `PLY→PCD` 矩阵会标记为已过期，但仍可查看和复制。

## 15．通用双模型配准 API（v2）

`v2` 不再使用文件格式推断方向。模型 A、模型 B 均支持 PLY、PCD、LAS 和 LAZ；业务输出方向与 ICP 移动模型分别指定。无论选择哪一个模型移动，结果始终同时返回两个世界坐标矩阵：

```text
p_b = T_a_to_b × p_a
p_a = T_b_to_a × p_b
T_b_to_a = inverse(T_a_to_b)
```

### 15.1 创建会话

```http
POST /api/v2/registration-sessions
Content-Type: multipart/form-data
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `model_a` | binary | 是 | — | `.ply`、`.pcd`、`.las` 或 `.laz` |
| `model_b` | binary | 是 | — | `.ply`、`.pcd`、`.las` 或 `.laz` |
| `output_direction` | string | 否 | `a_to_b` | 页面重点展示 `a_to_b` 或 `b_to_a` |
| `moving_model` | string | 否 | `auto` | `a`、`b` 或 `auto`；只影响 ICP 计算角色，不改变业务方向 |
| `workspace_id` | string／UUID | 否 | 服务生成 | 隔离调用方历史；浏览器持久化生成的 UUID，API 调用方应保存并复用 |
| `model_a_transform` | JSON string | 否 | 单位变换 | A 文件坐标→A 业务坐标的平移、旋转、缩放参数 |
| `model_b_transform` | JSON string | 否 | 单位变换 | B 文件坐标→B 业务坐标的平移、旋转、缩放参数 |

```bash
curl -X POST "http://localhost:8765/api/v2/registration-sessions" \
  -F "model_a=@scene.ply" \
  -F "model_b=@slam-map.laz" \
  -F 'model_a_transform={"translation":[0,0,0],"rotation_degrees":[-90,0,0],"scale":[1,1,1]}' \
  -F "output_direction=a_to_b" \
  -F "moving_model=b"
```

成功返回 `202 Accepted`，响应包含 `session_id`、`workspace_id`、`status_url` 和 `editor_url`。查询：

```http
GET /api/v2/registration-sessions/{session_id}
```

状态为 `ready` 时，`metadata.models.a` 和 `metadata.models.b` 分别包含格式、原始点数、预览点数、局部原点和包围盒；`metadata.recommended_moving_model` 是根据包围盒尺度和点数给出的建议，不会限制用户选择。

预览地址：

```http
GET /api/v2/registration-sessions/{session_id}/preview/model-a
GET /api/v2/registration-sessions/{session_id}/preview/model-b
GET /api/v2/registration-sessions/{session_id}/preview/gaussian-a
GET /api/v2/registration-sessions/{session_id}/preview/gaussian-b
```

Gaussian 地址仅在对应输入为包含 Gaussian 属性的 PLY 时存在。轻量预览不参与最终 ICP。

预变换采用列向量和 `P = T × Rz × Ry × Rx × S`。平移单位为米，旋转单位为度，缩放必须大于零。未传参数时平移／旋转为 `0`、缩放为 `1`。会话创建后可更新：

```http
PUT /api/v2/registration-sessions/{session_id}/business-transforms
Content-Type: application/json
```

```json
{"model_a":{"translation":[0,0,0],"rotation_degrees":[-90,0,0],"scale":[1,1,1]},"model_b":{"translation":[0,0,0],"rotation_degrees":[0,0,0],"scale":[1,1,1]}}
```

运行 ICP 时禁止修改。修改后必须重新粗配准和 ICP。

### 15.2 提交粗配准矩阵并执行 ICP

```http
POST /api/v2/registration-sessions/{session_id}/register
Content-Type: application/json
```

```json
{
  "initial_moving_local_to_fixed_local": [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1]
  ],
  "output_direction": "a_to_b",
  "moving_model": "b",
  "min_rms_decrease": 0.00001,
  "sampling_limit": 50000,
  "overlap": 1.0,
  "random_seed": 42
}
```

`initial_moving_local_to_fixed_local` 必须与本次 `moving_model` 对应。例如 `moving_model=b` 时，它表示 B 局部坐标到 A 局部坐标的初始矩阵。对于 LAS／LAZ，大坐标世界原点由服务在双精度中组合，调用方不得把世界原点预先乘入该局部粗配准矩阵。

服务始终生成轻量逐轮事件，不需要调用方根据界面勾选状态决定是否输出。兼容旧版服务端时可以固定传入 `show_registration_progress=true`；新版服务端仍会接受该字段，但不再由它控制 Worker。是否显示只由浏览器订阅行为决定，不改变采样、收敛条件或最终矩阵。

响应仍返回标准异步任务；使用响应中的 `status_url` 查询，成功后读取 `result_url`。响应中的 `progress_url` 可用于订阅逐轮进度。结果重点字段：

| 字段 | 说明 |
|---|---|
| `recommended_matrix` | 由 `output_direction` 选择的重点业务矩阵及明确公式 |
| `a_to_b` | 模型 A 业务坐标到模型 B 业务坐标 |
| `b_to_a` | 模型 B 业务坐标到模型 A 业务坐标，严格为前者的逆 |
| `file_a_to_b`／`file_b_to_a` | 原始文件坐标之间的 ICP 世界矩阵，用于诊断 |
| `business_transforms` | A／B 九参数及自动生成的文件→业务矩阵 |
| `moving_model`／`fixed_model` | 本轮实际 ICP 角色 |
| `initial_moving_local_to_fixed_local` | 人工粗配准局部矩阵 |
| `icp_refinement_moving_local_to_fixed_local` | ICP 在初始矩阵后的增量 |
| `moving_local_to_fixed_local` | 增量与初始矩阵组合后的最终局部矩阵 |
| `model_a.origin`／`model_b.origin` | 组合世界矩阵使用的双精度局部原点 |
| `metrics`／`parameters` | RMS、参与点数、耗时和实际参数 |

客户端不得根据 `moving_model` 猜测矩阵方向，应始终按字段名读取 `a_to_b` 或 `b_to_a`。`recommended_matrix.value` 只是其中一个方向的快捷入口。

业务矩阵组合公式为 `a_to_b = P_b × file_a_to_b × inverse(P_a)`。航点属于 A 业务场景时，可以直接使用 `a_to_b`，不得再次手工补旋转。

### 15.3 订阅 ICP 逐轮进度

```http
GET /api/v1/registrations/{job_id}/events
Accept: text/event-stream
```

该 SSE 接口由 `v1` 和 `v2` 任务共用。每个已接受迭代产生一个 `iteration` 事件：

```text
event: iteration
data: {"iteration":12,"rms":0.238421,"point_count":50000,"elapsed_seconds":3.84,"moving_local_to_fixed_local":[[...],[...],[...],[0,0,0,1]]}
```

`moving_local_to_fixed_local` 是当前移动模型局部坐标到固定模型局部坐标的累计中间矩阵，仅供视口动画和诊断，不是航点转换矩阵。任务结束时发送 `terminal` 事件；成功后必须读取 `result_url`，并以 `recommended_matrix.value`、`a_to_b` 或 `b_to_a` 的最终世界矩阵作为业务结果。任务被终止时，最后一个中间姿态未收敛，不得用于航点转换。

运行中途开始显示时使用：

```http
GET /api/v1/registrations/{job_id}/events?from_latest=true
```

服务会先发送当前最新一轮，再继续推送后续迭代，不会从第一轮重新播放。

### 15.4 终止配准任务

```http
POST /api/v1/registrations/{job_id}/cancel
```

该任务接口由 `v1` 和 `v2` 会话共用。只有 `queued` 或 `running` 状态可以终止；服务会结束对应 C++ Worker、将状态设置为 `cancelled`，并清除会话的 `active_job_id`。重复取消已取消任务按幂等方式返回 `cancelled`；取消已成功或已失败的任务返回 `409`。终止后可以保留当前浏览器粗配准姿态和参数并重新提交。

### 15.5 CLI 等价调用

```powershell
registration_worker.exe register-models `
  --model-a scene.ply `
  --model-b slam-map.laz `
  --moving-model b `
  --output-direction a_to_b `
  --initial-matrix initial-moving-to-fixed.txt `
  --progress-jsonl `
  --output-dir runtime\jobs\generic
```

启用 `--progress-jsonl` 后，标准输出先逐行输出 `type=iteration` 的紧凑 JSON，最后仍输出完整成功结果 JSON。输出目录包含 `registration.json`、`a_to_b_matrix.txt`、`b_to_a_matrix.txt` 和三个方向明确的局部矩阵文件。

### 15.6 历史结果与源文件生命周期

配准成功后，服务在 `runtime/history/{workspace_id}/{session_id}.json` 写入独立轻量档案。档案保存正反向矩阵、矩阵方向、模型文件名／格式／大小／点数／SHA-256、ICP 参数、RMS、服务版本和完成时间，不依赖随后会清理的 Job 目录。

```http
GET /api/v2/registration-history?workspace_id={workspace_id}
GET /api/v2/registration-history/{session_id}?workspace_id={workspace_id}
```

列表按完成时间倒序。`source_available=true` 且 `restartable=true` 表示两个源模型仍存在；`source_expires_at_unix` 是计划释放时间。源文件默认保留 24 小时。

```http
POST /api/v2/registration-sessions/{session_id}/retain
POST /api/v2/registration-sessions/{session_id}/release
POST /api/v2/registration-sessions/{session_id}/resume
Content-Type: application/json

{"workspace_id":"3bca89b2-5a40-4cca-bf67-477ab26dd848"}
```

- `retain`：从当前时间起再保留 24 小时。
- `release`：立即删除源模型、预览缓存、会话日志和对应已完成 Job，只保留历史档案；存在 `queued`／`running` 任务时返回 `409`。
- `resume`：验证源模型存在，并在预览丢失时重新生成预览；源文件已释放时返回 `409`。

`workspace_id` 用于本地历史隔离，不等同于生产鉴权。公网或多租户部署仍必须增加身份认证，并将工作区与真实用户绑定。
