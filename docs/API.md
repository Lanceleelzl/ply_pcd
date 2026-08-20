# PLY／PCD Registration Service API

## 1．文档信息

| 项目 | 内容 |
|---|---|
| API 名称 | PLY／PCD Registration Service API |
| API 版本 | `v1` |
| 服务版本 | `0.1.0` |
| 协议 | HTTP／JSON／multipart/form-data |
| 本地 Base URL | `http://localhost:8765` |
| OpenAPI | `/openapi.json` |
| Swagger UI | `/docs` |
| 认证 | 当前版本未启用，禁止直接暴露到公网 |

## 2．业务说明

服务接收 Gaussian Splatting PLY 模型和无人机 SLAM PCD 点云，使用 PCD 作为移动点云、PLY 作为固定点云执行 ICP，然后返回双向坐标转换矩阵。

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

## 5．接口列表

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `POST` | `/api/v1/registrations` | 上传文件并创建配准任务 |
| `GET` | `/api/v1/registrations/{job_id}` | 查询任务状态 |
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
| `pcd` | binary | 是 | — | 文件名以 `.pcd` 结尾，非空 | SLAM PCD 点云 |
| `min_rms_decrease` | number | 否 | `0.00001` | `1e-8 <= value <= 1e-3` | RMS 收敛阈值，不是最终误差目标 |
| `sampling_limit` | integer | 否 | `50000` | `10000 <= value <= 500000` | ICP 最大采样点数；默认值已通过 CloudCompare 手工验证 |
| `overlap` | number | 否 | `1.0` | `0.5 <= value <= 1` | PCD 中预计有效匹配点比例；默认值已通过 CloudCompare 手工验证 |
| `random_seed` | integer | 否 | `42` | `0 <= value <= 4294967295` | 随机采样种子，用于结果复现 |

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
    "name": "T_ply_to_pcd",
    "direction": "PLY_TO_PCD",
    "formula": "p_pcd = T_ply_to_pcd * p_ply",
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
| `recommended_matrix.value` | number[4][4] | 最终业务使用的高精度 PLY→PCD 矩阵 |
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

- 上传的 PLY／PCD 副本在任务成功或失败后立即删除。
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
```

## 15．生产部署注意事项

当前 `v1` 是单机 MVP。对外提供服务前至少应增加：

- HTTPS 和反向代理。
- 身份认证与调用权限。
- 上传文件大小限制。
- 明确的 CORS Origin 白名单。
- 磁盘容量与任务失败监控。
- 多实例场景下的持久化任务队列和共享对象存储。
